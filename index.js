var Imap = require('imap');
var util = require('util');
var EventEmitter = require('events').EventEmitter;
var MailParser = require("mailparser").MailParser;
const simpleParser = require('mailparser').simpleParser;

var fs = require("fs");
var path = require('path');
var async = require('async');

module.exports = MailListener;

function MailListener(options) {
  this.markSeen = !! options.markSeen;
  this.mailbox = options.mailbox || "INBOX";
  if ('string' === typeof options.searchFilter) {
    this.searchFilter = [options.searchFilter];
  } else {
    this.searchFilter = options.searchFilter || ["UNSEEN"];
  }
  this.fetchUnreadOnStart = !! options.fetchUnreadOnStart;
  this.mailParserOptions = options.mailParserOptions || {};
  if (options.attachments && options.attachmentOptions && options.attachmentOptions.stream) {
    this.mailParserOptions.streamAttachments = true;
  }
  this.attachmentOptions = options.attachmentOptions || {};
  this.attachments = options.attachments || false;
  this.attachmentOptions.directory = (this.attachmentOptions.directory ? this.attachmentOptions.directory : '');
  this.imap = new Imap({
    xoauth2: options.xoauth2,
    user: options.username,
    password: options.password,
    host: options.host,
    port: options.port,
    tls: options.tls,
    tlsOptions: options.tlsOptions || {},
    connTimeout: options.connTimeout || null,
    authTimeout: options.authTimeout || null,
    debug: options.debug || null,
    keepalive: options.keepalive || true
  });

  this.imap.once('ready', imapReady.bind(this));
  this.imap.once('close', imapClose.bind(this));
  this.imap.on('error', imapError.bind(this));
}

util.inherits(MailListener, EventEmitter);

MailListener.prototype.start = function() {
  this.imap.connect();
};

MailListener.prototype.stop = function() {
  this.imap.end();
};

function imapReady() {
  var self = this;
  this.imap.openBox(this.mailbox, false, function(err, mailbox) {
    if (err) {
      self.emit('error', err);
    } else {
      self.emit('server:connected');
      if (self.fetchUnreadOnStart) {
        parseUnread.call(self);
      }
      var listener = imapMail.bind(self);
      self.imap.on('mail', listener);
      self.imap.on('update', listener);
    }
  });
}

function imapClose() {
  this.emit('server:disconnected');
}

function imapError(err) {
  this.emit('error', err);
}

function imapMail() {
  parseUnread.call(this);
}

function parseUnread() {
  var self = this;
  this.imap.search(self.searchFilter, function(err, results) {
    if (err) {
      self.emit('error', err);
    } else if (results.length > 0) {
      async.each(results, function( result, callback) {
        if(self.markSeen) {
          self.imap.setFlags(result, ['\\Seen'], function(err) {
            if (err) {
                console.log(JSON.stringify(err, null, 2));
            }
          });
        }

        var f = self.imap.fetch(result, {
          bodies: '',
        });
        f.on('message', function(msg, seqno) {
          var parser = new MailParser(self.mailParserOptions);
          var attributes = null;
          var emlbuffer = new Buffer('');
          parser.on("data", function(mail) {
            mail.eml = emlbuffer.toString('utf-8');
            simpleParser( mail.eml, (err, mail)=>{
              self.emit('mail', mail, seqno, attributes);
            })
          });
          parser.on("attachment", function (attachment) {
            self.emit('attachment', attachment);
          });
          msg.on('body', function(stream, info) {
            stream.on('data', function(chunk) {
              emlbuffer = Buffer.concat([emlbuffer, chunk]);
            });
            stream.once('end', function() {
              parser.write(emlbuffer);
              parser.end();
            });
          });
          msg.on('attributes', function(attrs) {
            attributes = attrs;
          });
        });
        f.once('error', function(err) {
          self.emit('error', err);
        });
      }, function(err){
        if( err ) {
          self.emit('error', err);
        }
      });
    }
  });
}
