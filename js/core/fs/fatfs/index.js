'use strict';

const events = require('./events');
const streams = require('stream');
const fifolock = require('./fifolock');
const S = require('./structs.js');
const _ = require('./helpers.js');

// _.log.level = _.log.DBG;

exports.createFileSystem = function (volume, opts, cb) {
  if (typeof opts === 'function') {
    cb = opts;
    opts = null;
  }
  opts = _.extend({
        // c.f. https://www.kernel.org/doc/Documentation/filesystems/vfat.txt
    ro: false,
    noatime: true,
    modmode: 0o111,       // or `07000`
    umask: ('umask' in process) ? process.umask() : 0o022,
    uid: ('getuid' in process) ? process.getuid() : 0,
    gid: ('getgid' in process) ? process.getgid() : 0,
  }, opts);
  if (!volume.writeSectors) opts.ro = true;
  if (opts.ro) opts.noatime = true;       // natch

  let fs = new events.EventEmitter(),
    vol = null,
    dir = require('./dir.js'),
    c = require('./chains.js'),
    q = fifolock();

  const GROUP = (_.log.level < _.log.INFO) ? q.TRANSACTION_WRAPPER.bind({
    postAcquire(proceed) {
      _.log(_.log.DBG, '=== Starting GROUP ===');
      proceed();
    },
    preRelease(finish) {
      _.log(_.log.DBG, '=== Finishing GROUP ===');
      finish();
    },
  }) : q.TRANSACTION_WRAPPER;

  q.acquire((unlock) => {         // because of this, callers can start before 'ready'
    const d = new Buffer(volume.sectorSize);
    volume.readSectors(0, d, (e) => {
      if (e) fs.emit('error', e);
      else {
        try {
          init(d);
        } catch (e) {
          fs.emit('error', e);
          unlock();
          return;
        }
        fs.emit('ready');
      }
      unlock();
    });
  });

  if (cb) fs.on('error', cb).on('ready', cb.bind(null, null));

  function init(bootSector) {
    vol = require('./vol.js').init(volume, opts, bootSector);
    fs._dirIterator = dir.iterator.bind(dir);

    let entryInfoByPath = {},
      baseEntry = {
        _refs: 0,
        _record() {
          entryInfoByPath[this.path] = this;
          if (this.parent) this.parent.retain();
          return this;
        },
        retain() {
          if (!this._refs) this._record();
          this._refs += 1;
          return this;
        },
        release() {
          this._refs -= 1;
          if (!this._refs) this._rescind();
        },
        _rescind() {
          if (this.parent) this.parent.release();
          delete entryInfoByPath[this.path];
        },
      };
    fs._createSharedEntry = function (path, entry, chain, parent) {
      return _.extend(Object.create(baseEntry), {
        _refs: 0,           // WORKAROUND: https://github.com/tessel/beta/issues/455
        path,
        entry,
        chain,
        parent,
      }).retain();
    };
    fs._createSharedEntry('/', { Attr: { directory: true } }, vol.rootDirectoryChain);
    fs._sharedEntryForSteps = function (steps, opts, cb) {         // NOTE: may `cb` before returning!
      let path = steps.join('/') || '/',
        name = steps.pop(), // n.b.
        info = entryInfoByPath[path];
      if (info) cb(null, info.retain());
      else {
        fs._sharedEntryForSteps(steps, {}, (e, parentInfo) => {  // n.b. `steps` don't include `name`
          if (e) cb(e);
          else if (!parentInfo.entry.Attr.directory) cb(S.err.NOTDIR());
          else {
            dir.findInDirectory(vol, parentInfo.chain, name, opts, (e, entry) => {
              if (e && !opts.prepareForCreate) cb(e);
              else if (e) cb(e, { missingChild: _.extend(entry, { name }), parent: parentInfo });
              else cb(null, fs._createSharedEntry(path, entry, vol.chainForCluster(entry._firstCluster), parentInfo));
            });
          }
        });
      }
    };

    fs._updateEntry = dir.updateEntry.bind(dir, vol);
    fs._makeStat = dir.makeStat.bind(dir, vol);
    fs._addFile = dir.addFile.bind(dir, vol);
    fs._initDir = dir.init.bind(dir, vol);
  }


    /** ** ---- CORE API ---- ****/

    // NOTE: we really don't share namespace, but avoid first three anyway…
  const fileDescriptors = [null, null, null];

  fs.open = function (path, flags, mode, cb, _n_) {
    if (typeof mode === 'function') {
      _n_ = cb;
      cb = mode;
      mode = 0o666;
    }
    cb = GROUP(cb, () => {
      let _fd = { flags: null, entry: null, chain: null, pos: 0 },
        f = _.parseFlags(flags);
      if (vol.opts.ro && (f.write || f.create || f.truncate)) return _.delayedCall(cb, S.err.ROFS());
      _fd.flags = f;

      fs._sharedEntryForSteps(_.absoluteSteps(path), { prepareForCreate: f.create }, (e, info) => {
        if (e && !(e.code === 'NOENT' && f.create && info)) cb(e);
        else if (e) {
          fs._addFile(info.parent.chain, info.missingChild, { dir: f._openDir }, (e, newEntry, newChain) => {
            if (e) cb(e);
            else finish(fs._createSharedEntry(_.absolutePath(path), newEntry, newChain, info.parent));
          });
        } else if (info && f.exclusive) cb(S.err.EXIST());
        else if (info.entry.Attr.directory && !f._openDir) cb(S.err.ISDIR());
        else if (f.write && info.entry.Attr.readonly) cb(S.err.ACCES());
        else finish(info);
        function finish(fileInfo) {
          const fd = fileDescriptors.push(_fd) - 1;
          _fd.info = fileInfo;
          _fd.entry = fileInfo.entry;
          _fd.chain = fileInfo.chain;
          if (f.append) _fd.pos = _fd.entry._size;
          if (f._openDir) _fd.chain.cacheAdvice = 'WILLNEED';
          if (f.truncate && _fd.entry._size) {
            fs.ftruncate(fd, 0, (e) => {
              cb(e, fd);
            }, '_nested_');
          } else _.delayedCall(cb, null, fd);       // (delay in case fs._sharedEntryForSteps all cached!)
        }
      });
    }, (_n_ === '_nested_'));
  };

  fs.fstat = function (fd, cb, _n_) {
    cb = GROUP(cb, () => {
      const _fd = fileDescriptors[fd];
      if (!_fd || !_fd.flags.read) _.delayedCall(cb, S.err.BADF());
      else _.delayedCall(cb, null, fs._makeStat(_fd.entry));
    }, (_n_ === '_nested_'));
  };

  fs.futimes = function (fd, atime, mtime, cb, _n_) {
    cb = GROUP(cb, () => {
      const _fd = fileDescriptors[fd];
      if (!_fd || !_fd.flags.write) _.delayedCall(cb, S.err.BADF());
        // NOTE: ctime would get touched on POSIX; but we map that to create time!
      else fs._updateEntry(_fd.entry, { atime: atime || true, mtime: mtime || true }, cb);
    }, (_n_ === '_nested_'));
  };

  fs.fchmod = function (fd, mode, cb, _n_) {
    cb = GROUP(cb, () => {
      const _fd = fileDescriptors[fd];
      if (!_fd || !_fd.flags.write) _.delayedCall(cb, S.err.BADF());
      else {
        mode &= S._I._chmoddable;
        if (_fd.entry.Attr.directory) mode |= S._I.FDIR;
        else if (!_fd.entry.Attr.volume_id) mode |= S._I.FREG;
        fs._updateEntry(_fd.entry, { mode }, cb);
      }
    }, (_n_ === '_nested_'));
  };

  fs.read = function (fd, buf, off, len, pos, cb, _n_) {
    cb = GROUP(cb, () => {
      const _fd = fileDescriptors[fd];
      if (!_fd || !_fd.flags.read) _.delayedCall(cb, S.err.BADF());

      let _pos = (pos === null) ? _fd.pos : pos,
        _len = Math.min(len, _fd.entry._size - _pos),
        _buf = buf.slice(off, off + _len);
      _fd.chain.readFromPosition(_pos, _buf, (e, bytes, slice) => {
        if (_.workaroundTessel380) _buf.copy(buf, off);        // WORKAROUND: https://github.com/tessel/beta/issues/380
        _fd.pos = _pos + bytes;
        if (e || vol.opts.noatime) finish(e);
        else fs._updateEntry(_fd.entry, { atime: true }, finish);
        function finish(e) {
          cb(e, bytes, buf);
        }
      });
    }, (_n_ === '_nested_'));
  };

  fs._readdir = function (fd, cb, _n_) {
    cb = GROUP(cb, () => {
      const _fd = fileDescriptors[fd];
      if (!_fd || !_fd.flags.read) _.delayedCall(cb, S.err.BADF());
      else {
        let entryNames = [],
          getNextEntry = fs._dirIterator(_fd.chain);
        function processNext() {
          getNextEntry((e, d) => {
            if (e) cb(e);
            else if (!d && !entryNames.length) cb(null, entryNames); // WORKAROUND: https://github.com/tessel/beta/issues/435
            else if (!d) cb(null, entryNames.sort());       // NOTE: sort not required, but… [simplifies tests for starters!]
            else {
              if (d._name !== '.' && d._name !== '..') entryNames.push(d._name);
              processNext();
            }
          });
        }
        processNext();
      }
    }, (_n_ === '_nested_'));
  };

  fs._mkdir = function (fd, cb, _n_) {
    cb = GROUP(cb, () => {
      const _fd = fileDescriptors[fd];
      if (!_fd || !_fd.flags.write) _.delayedCall(cb, S.err.BADF());
      else fs._initDir(_fd.info, cb);
    }, (_n_ === '_nested_'));
  };

  fs.write = function (fd, buf, off, len, pos, cb, _n_) {
    cb = GROUP(cb, () => {
      const _fd = fileDescriptors[fd];
      if (!_fd || !_fd.flags.write) _.delayedCall(cb, S.err.BADF());

      let _pos = (pos === null || _fd.flags.append) ? _fd.pos : pos,
        _buf = buf.slice(off, off + len);
      if (_pos > _fd.entry._size) {
            // TODO: handle huge jumps by zeroing clusters individually?
        let padLen = _pos - _fd.entry._size,
          padBuf = new Buffer(padLen + _buf.length);
        padBuf.fill(0x00, 0, padLen);
        _buf.copy(padBuf, padLen);
        _pos = _fd.entry._size;
        _buf = padBuf;
      }
      _fd.chain.writeToPosition(_pos, _buf, (e) => {
        _fd.pos = _pos + len;
        let newSize = Math.max(_fd.entry._size, _fd.pos),
          newInfo = { size: newSize, _touch: true };
        fs._updateEntry(_fd.entry, newInfo, (ee) => {
          cb(e || ee, len, buf);
        });
      });
    }, (_n_ === '_nested_'));
  };

  fs.ftruncate = function (fd, len, cb, _n_) {
    cb = GROUP(cb, () => {
      const _fd = fileDescriptors[fd];
      if (!_fd || !_fd.flags.write) _.delayedCall(cb, S.err.BADF());

      const newStats = { size: len, _touch: true };
        // NOTE: we order operations for best state in case of only partial success
      if (len === _fd.entry._size) _.delayedCall(cb);
      else if (len < _fd.entry._size) {
        fs._updateEntry(_fd.entry, newStats, (e) => {
          if (e) cb(e);
          else _fd.chain.truncate(Math.ceil(len / _fd.chain.sectorSize), cb);
        });
      }     // TODO: handle huge file expansions without as much memory pressure
      else {
        _fd.chain.writeToPosition(_fd.entry._size, _.filledBuffer(len - _fd.entry._size, 0x00), (e) => {
          if (e) cb(e);
          else fs._updateEntry(_fd.entry, newStats, cb);
        });
      }
    }, (_n_ === '_nested_'));
  };

    // 'NORMAL', 'SEQUENTIAL', 'RANDOM', 'WILLNEED', 'DONTNEED', 'NOREUSE'
  fs._fadviseSync = function (fd, off, len, advice) {
    if (off !== 0 || len !== 0) throw Error('Cache advise can currently be given only for whole file!');
    const _fd = fileDescriptors[fd];
    if (!_fd) throw S.err.BADF();
    else _fd.chain.cacheAdvice = advice;
  };

  fs.fsync = function (fd, cb) {
        // NOTE: we'll need to flush write cache here once we have one…
    const _fd = fileDescriptors[fd];
    if (!_fd) _.delayedCall(cb, S.err.BADF());
    else _.delayedCall(cb);
  };

  fs.close = function (fd, cb) {
    const _fd = fileDescriptors[fd];
    if (!_fd) _.delayedCall(cb, S.err.BADF());
    else setTimeout(_fd.info.release.bind(_fd.info), 500), _.delayedCall(cb, fileDescriptors[fd] = null);
  };


    /* STREAM WRAPPERS */

  let workaroundTessel436;
  try {
    new require('stream').Readable({ encoding: 'utf8' });
    new streams.Readable({ encoding: 'utf8' });
  } catch (e) {
    workaroundTessel436 = true;
  }

  function _createStream(StreamType, path, opts) {
        // [NOT REALLY A] WORKAROUND: https://github.com/tessel/beta/issues/436
    if (workaroundTessel436 && 'encoding' in opts) {
      console.warn('Tessel does not currently support encoding option for Readable streams, discarding!');
      delete opts.encoding;
    }

    let fd = (opts.fd !== null) ? opts.fd : '_opening_',
      pos = opts.start,
      stream = new StreamType(opts);

    if (fd === '_opening_') {
      fs.open(path, opts.flags, opts.mode, (e, _fd) => {
        if (e) {
          fd = '_open_error_';
          stream.emit('error', e);
        } else {
          fd = _fd;
          fs._fadviseSync(fd, 0, 0, 'SEQUENTIAL');
          stream.emit('open', fd);
        }
      });
    }

    function autoClose(tombstone) {      // NOTE: assumes caller will clear `fd`
      if (opts.autoClose) {
        fs.close(fd, (e) => {
          if (e) stream.emit('error', e);
          else stream.emit('close');
        });
      }
      fd = tombstone;
    }

    if (StreamType === streams.Readable) {
      stream._read = function (n) {
        let buf;
                // TODO: optimize to fetch at least a full sector regardless of `n`…
        n = Math.min(n, opts.end - pos);
        if (fd === '_opening_') stream.once('open', () => { stream._read(n); });
        else if (pos > opts.end) stream.push(null);
        else if (n > 0) {
          buf = new Buffer(n), fs.read(fd, buf, 0, n, pos, (e, n, d) => {
            if (e) {
              autoClose('_read_error_');
              stream.emit('error', e);
            } else stream.push((n) ? d.slice(0, n) : null);
          }), pos += n;
        } else stream.push(null);
      };

      stream.once('end', () => {
        autoClose('_ended_');
      });
    } else if (StreamType === streams.Writable) {
      stream.bytesWritten = 0;

      stream._write = function (data, _enc, cb) {
        if (fd === '_opening_') stream.once('open', () => { stream._write(data, null, cb); });
        else {
          fs.write(fd, data, 0, data.length, pos, (e, n) => {
            if (e) {
              autoClose('_write_error_');
              cb(e);
            } else {
              stream.bytesWritten += n;
              cb();
            }
          }), pos += data.length;
        }
      };

      stream.once('finish', () => {
        autoClose('_finished_');
      });
    }

    return stream;
  }

  fs.createReadStream = function (path, opts) {
    return _createStream(streams.Readable, path, _.extend({
      start: 0,
      end: Infinity,
      flags: 'r',
      mode: 0o666,
      encoding: null,
      fd: null,           // ??? see https://github.com/joyent/node/issues/7708
      autoClose: true,
    }, opts));
  };

  fs.createWriteStream = function (path, opts) {
    return _createStream(streams.Writable, path, _.extend({
      start: 0,
      flags: 'w',
      mode: 0o666,
            // encoding: null,   // see https://github.com/joyent/node/issues/7710
      fd: null,           // ??? see https://github.com/joyent/node/issues/7708
      autoClose: true,
    }, opts, { decodeStrings: true, objectMode: false }));
  };


    /* PATH WRAPPERS (albeit the only public interface for some folder operations) */

  function _fdOperation(path, opts, fn, cb) {
    cb = GROUP(cb, () => {
      opts.advice || (opts.advice = 'NORMAL');
      fs.open(path, opts.flag, (e, fd) => {
        if (e) cb(e);
        else {
          fs._fadviseSync(fd, 0, 0, opts.advice), fn(fd, function () {
            let ctx = this,
              args = arguments;
            fs.close(fd, (closeErr) => {
              cb.apply(ctx, args);
            }, '_nested_');
          });
        }
      }, '_nested_');
    });
  }

  fs.stat = fs.lstat = function (path, cb) {
    _fdOperation(path, { flag: 'r' }, (fd, cb) => {
      fs.fstat(fd, cb, '_nested_');
    }, cb);
  };

  fs.exists = function (path, cb) {
    fs.stat(path, (err) => {
      cb(!err);
    });
  };

  fs.readFile = function (path, opts, cb) {
    if (typeof opts === 'function') {
      cb = opts;
      opts = {};
    }
    opts.flag || (opts.flag = 'r');
    opts.advice || (opts.advice = 'NOREUSE');
    _fdOperation(path, opts, (fd, cb) => {
      fs.fstat(fd, (e, stat) => {
        if (e) return cb(e);

        const buffer = new Buffer(stat.size);
        fs.read(fd, buffer, 0, buffer.length, null, (e) => {
          if (e) cb(e);
          else cb(null, (opts.encoding) ? buffer.toString(opts.encoding) : buffer);
        }, '_nested_');
      }, '_nested_');
    }, cb);
  };

  fs.writeFile = function (path, data, opts, cb) {
    if (typeof opts === 'function') {
      cb = opts;
      opts = {};
    }
    opts.flag || (opts.flag = 'w');
    opts.advice || (opts.advice = 'NOREUSE');
    _fdOperation(path, opts, (fd, cb) => {
      if (typeof data === 'string') data = new Buffer(data, opts.encoding || 'utf8');
      fs.write(fd, data, 0, data.length, null, (e) => { cb(e); }, '_nested_');
    }, cb);
  };

  fs.appendFile = function (path, data, opts, cb) {
    if (typeof opts === 'function') {
      cb = opts;
      opts = {};
    }
    opts.flag || (opts.flag = 'a');
    fs.writeFile(path, data, opts, cb);
  };

  fs.truncate = function (path, len, cb) {
    _fdOperation(path, { flag: 'r+' }, (fd, cb) => {
      fs.ftruncate(fd, len, cb, '_nested_');
    }, cb);
  };

  fs.readdir = function (path, cb) {
    _fdOperation(path, { flag: '\\r' }, (fd, cb) => {
      fs._readdir(fd, cb, '_nested_');
    }, cb);
  };

  fs.mkdir = function (path, mode, cb) {
    if (typeof mode === 'function') {
      cb = mode;
      mode = 0o777;
    }
    _fdOperation(path, { flag: '\\wx' }, (fd, cb) => {
      fs._mkdir(fd, cb, '_nested_');
    }, cb);
  };

  fs.utimes = function (path, atime, mtime, cb) {
    _fdOperation(path, { flag: 'r+' }, (fd, cb) => {
      fs.futimes(fd, atime, mtime, cb, '_nested_');
    }, cb);
  };

  fs.chmod = fs.lchmod = function (path, mode, cb) {
    _fdOperation(path, { flag: '\\r+' }, (fd, cb) => {
      fs.fchmod(fd, mode, cb, '_nested_');
    }, cb);
  };

  fs.chown = fs.lchown = function (path, uid, gid, cb) {
    _fdOperation(path, { flag: '\\r+' }, (fd, cb) => {
      fs.fchown(fd, uid, gid, cb, '_nested_');
    }, cb);
  };


    /* STUBS */

  fs.link = function (src, dst, cb) {
        // NOTE: theoretically we _could_ do hard links [with untracked `stat.nlink` count…]
    _.delayedCall(cb, S.err.NOSYS());
  };

  fs.symlink = function (src, dst, type, cb) {
    if (typeof type === 'function') {
      cb = type;
      type = null;
    }
    _.delayedCall(cb, S.err.NOSYS());
  };

  fs.readlink = function (path, cb) {
    _fdOperation(path, { flag: '\\r' }, (fd, cb) => {
            // the named file is *never* a symbolic link…
            // NOTE: we still use _fdOperation for catching e.g. NOENT/NOTDIR errors…
      cb(S.err.INVAL());
    }, cb);
  };

  fs.realpath = function (path, cache, cb) {
    if (typeof cache === 'function') {
      cb = cache;
      cache = null;
    }
    if (cache) _.delayedCall(cb, S.err.NOSYS());        // TODO: what would be involved here?
    else {
      _fdOperation(path, { flag: '\\r' }, (fd, cb) => {
        cb(null, _.absolutePath(path));
      }, cb);
    }
  };

  fs.fchown = function (fd, uid, gid, cb, _n_) {
    cb = GROUP(cb, () => {
      const _fd = fileDescriptors[fd];
      if (!_fd || !_fd.flags.write) _.delayedCall(cb, S.err.BADF());
      else _.delayedCall(cb, S.err.NOSYS());
    }, (_n_ === '_nested_'));
  };


  return fs;
};