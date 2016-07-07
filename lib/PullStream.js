var Stream = require('stream');
var Promise = require('bluebird');
var util = require('util')
var Buffer = require('buffer').Buffer;

function PullStream() {
  if (!(this instanceof PullStream))
    return new PullStream();

  Stream.Writable.call(this,{decodeStrings:false});
  this.buffer = new Buffer(''); 
}

util.inherits(PullStream,Stream.Writable);

PullStream.prototype._write = function(chunk,e,cb) {
  this.buffer = Buffer.concat([this.buffer,chunk]);
  this.cb = cb;
  this.emit('chunk');
};

PullStream.prototype.next = function() {
  if (this.cb) {
    this.cb();
    this.cb = undefined;
  }
  
  if (this.flushcb) {
    this.flushcb();
  }
};

PullStream.prototype.ReadStream = function(len) {
  var p = Stream.PassThrough();
  var self = this;
  var count = 0;

  function pull() {
    if (self.buffer && self.buffer.length) {
      var packet = self.buffer.slice(0,len);
      self.buffer = self.buffer.slice(len);
      len -= packet.length;
      p.write(packet);
    }
    
    if (len) {
      if (self.flushcb)
        self.emit('error','FILE_ENDED');
      self.next();
    } else {
      self.removeListener('chunk',pull);
      p.end();
    }
  }
  self.on('chunk',pull);
  pull();
  return p;
};

PullStream.prototype.Read = function(len) {
  var buffer = new Buffer('');
  var self = this;
  return new Promise(function(resolve,reject) {
    self.ReadStream(len)
      .pipe(Stream.Transform({
        transform: (d,e,cb) => {
          buffer = Buffer.concat([buffer,d])
          cb();
        }
      }))
      .on('finish',() => resolve(buffer));
  });
};

PullStream.prototype.Read2 = function(len) {
  var self = this;
  return new Promise(function(resolve,reject) {
    function pull() {
      if (self.buffer && self.buffer.length > len) {
        var ret = self.buffer.slice(0,len);
        self.buffer = self.buffer.slice(len);
        if (!self.buffer.length)
          self.next();
        self.removeListener('chunk',pull);
        return resolve(ret);
      }
      
      if (self.flushcb)
        return self.emit('error','FILE_ENDED');

      self.next();
    }

    self.on('chunk',pull);
    pull();
  });
};

PullStream.prototype.pull = function(len,cb) {
  return this.Read(len)
    .then(d => {cb(null,d)},e => cb(e));
};

PullStream.prototype.pipe = function(len,op) {
  return this.ReadStream(len)
    .pipe(op);
};

module.exports = PullStream;
