'use strict';

const {
  Array,
  BigInt,
  FunctionPrototypeBind,
  FunctionPrototypeCall,
  MathMin,
  NumberIsNaN,
  NumberIsSafeInteger,
  NumberPrototypeToString,
  StringPrototypePadStart,
} = primordials;

const {
  RandomBytesJob,
  RandomPrimeJob,
  CheckPrimeJob,
  kCryptoJobAsync,
  kCryptoJobSync,
  secureBuffer,
} = internalBinding('crypto');

const {
  lazyDOMException,
} = require('internal/crypto/util');

const { Buffer, kMaxLength } = require('buffer');

const {
  codes: {
    ERR_INVALID_ARG_TYPE,
    ERR_OUT_OF_RANGE,
    ERR_OPERATION_FAILED,
  }
} = require('internal/errors');

const {
  validateNumber,
  validateBoolean,
  validateCallback,
  validateObject,
  validateUint32,
} = require('internal/validators');

const {
  isArrayBufferView,
  isAnyArrayBuffer,
  isBigInt64Array,
  isFloat32Array,
  isFloat64Array,
} = require('internal/util/types');

const { FastBuffer } = require('internal/buffer');

const kMaxUint32 = 2 ** 32 - 1;
const kMaxPossibleLength = MathMin(kMaxLength, kMaxUint32);

function assertOffset(offset, elementSize, length) {
  validateNumber(offset, 'offset');
  offset *= elementSize;

  const maxLength = MathMin(length, kMaxPossibleLength);
  if (NumberIsNaN(offset) || offset > maxLength || offset < 0) {
    throw new ERR_OUT_OF_RANGE('offset', `>= 0 && <= ${maxLength}`, offset);
  }

  return offset >>> 0;  // Convert to uint32.
}

function assertSize(size, elementSize, offset, length) {
  validateNumber(size, 'size');
  size *= elementSize;

  if (NumberIsNaN(size) || size > kMaxPossibleLength || size < 0) {
    throw new ERR_OUT_OF_RANGE('size',
                               `>= 0 && <= ${kMaxPossibleLength}`, size);
  }

  if (size + offset > length) {
    throw new ERR_OUT_OF_RANGE('size + offset', `<= ${length}`, size + offset);
  }

  return size >>> 0;  // Convert to uint32.
}

function randomBytes(size, callback) {
  size = assertSize(size, 1, 0, Infinity);
  if (callback !== undefined) {
    validateCallback(callback);
  }

  const buf = new FastBuffer(size);

  if (callback === undefined) {
    randomFillSync(buf.buffer, 0, size);
    return buf;
  }

  // Keep the callback as a regular function so this is propagated.
  randomFill(buf.buffer, 0, size, function(error) {
    if (error) FunctionPrototypeCall(callback, this, error);
    FunctionPrototypeCall(callback, this, null, buf);
  });
}

function randomFillSync(buf, offset = 0, size) {
  if (!isAnyArrayBuffer(buf) && !isArrayBufferView(buf)) {
    throw new ERR_INVALID_ARG_TYPE(
      'buf',
      ['ArrayBuffer', 'ArrayBufferView'],
      buf);
  }

  const elementSize = buf.BYTES_PER_ELEMENT || 1;

  offset = assertOffset(offset, elementSize, buf.byteLength);

  if (size === undefined) {
    size = buf.byteLength - offset;
  } else {
    size = assertSize(size, elementSize, offset, buf.byteLength);
  }

  if (size === 0)
    return buf;

  const job = new RandomBytesJob(
    kCryptoJobSync,
    buf,
    offset,
    size);

  const err = job.run()[0];
  if (err)
    throw err;

  return buf;
}

function randomFill(buf, offset, size, callback) {
  if (!isAnyArrayBuffer(buf) && !isArrayBufferView(buf)) {
    throw new ERR_INVALID_ARG_TYPE(
      'buf',
      ['ArrayBuffer', 'ArrayBufferView'],
      buf);
  }

  const elementSize = buf.BYTES_PER_ELEMENT || 1;

  if (typeof offset === 'function') {
    callback = offset;
    offset = 0;
    size = buf.bytesLength;
  } else if (typeof size === 'function') {
    callback = size;
    size = buf.byteLength - offset;
  } else {
    validateCallback(callback);
  }

  offset = assertOffset(offset, elementSize, buf.byteLength);

  if (size === undefined) {
    size = buf.byteLength - offset;
  } else {
    size = assertSize(size, elementSize, offset, buf.byteLength);
  }

  if (size === 0) {
    callback(null, buf);
    return;
  }

  // TODO(@jasnell): This is not yet handling byte offsets right
  const job = new RandomBytesJob(
    kCryptoJobAsync,
    buf,
    offset,
    size);
  job.ondone = FunctionPrototypeBind(onJobDone, job, buf, callback);
  job.run();
}

// Largest integer we can read from a buffer.
// e.g.: Buffer.from("ff".repeat(6), "hex").readUIntBE(0, 6);
const RAND_MAX = 0xFFFF_FFFF_FFFF;

// Generates an integer in [min, max) range where min is inclusive and max is
// exclusive.
function randomInt(min, max, callback) {
  // Detect optional min syntax
  // randomInt(max)
  // randomInt(max, callback)
  const minNotSpecified = typeof max === 'undefined' ||
    typeof max === 'function';

  if (minNotSpecified) {
    callback = max;
    max = min;
    min = 0;
  }

  const isSync = typeof callback === 'undefined';
  if (!isSync) {
    validateCallback(callback);
  }
  if (!NumberIsSafeInteger(min)) {
    throw new ERR_INVALID_ARG_TYPE('min', 'a safe integer', min);
  }
  if (!NumberIsSafeInteger(max)) {
    throw new ERR_INVALID_ARG_TYPE('max', 'a safe integer', max);
  }
  if (max <= min) {
    throw new ERR_OUT_OF_RANGE(
      'max', `greater than the value of "min" (${min})`, max
    );
  }

  // First we generate a random int between [0..range)
  const range = max - min;

  if (!(range <= RAND_MAX)) {
    throw new ERR_OUT_OF_RANGE(`max${minNotSpecified ? '' : ' - min'}`,
                               `<= ${RAND_MAX}`, range);
  }

  // For (x % range) to produce an unbiased value greater than or equal to 0 and
  // less than range, x must be drawn randomly from the set of integers greater
  // than or equal to 0 and less than randLimit.
  const randLimit = RAND_MAX - (RAND_MAX % range);

  if (isSync) {
    // Sync API
    while (true) {
      const x = randomBytes(6).readUIntBE(0, 6);
      if (x >= randLimit) {
        // Try again.
        continue;
      }
      return (x % range) + min;
    }
  } else {
    // Async API
    const pickAttempt = () => {
      randomBytes(6, (err, bytes) => {
        if (err) return callback(err);
        const x = bytes.readUIntBE(0, 6);
        if (x >= randLimit) {
          // Try again.
          return pickAttempt();
        }
        const n = (x % range) + min;
        callback(null, n);
      });
    };

    pickAttempt();
  }
}


function onJobDone(buf, callback, error) {
  if (error) return FunctionPrototypeCall(callback, this, error);
  FunctionPrototypeCall(callback, this, null, buf);
}

// Really just the Web Crypto API alternative
// to require('crypto').randomFillSync() with an
// additional limitation that the input buffer is
// not allowed to exceed 65536 bytes, and can only
// be an integer-type TypedArray.
function getRandomValues(data) {
  if (!isArrayBufferView(data) ||
      isBigInt64Array(data) ||
      isFloat32Array(data) ||
      isFloat64Array(data)) {
    // Ordinarily this would be an ERR_INVALID_ARG_TYPE. However,
    // the Web Crypto API and web platform tests expect this to
    // be a DOMException with type TypeMismatchError.
    throw lazyDOMException(
      'The data argument must be an integer-type TypedArray',
      'TypeMismatchError');
  }
  if (data.byteLength > 65536) {
    throw lazyDOMException(
      'The requested length exceeds 65,536 bytes',
      'QuotaExceededError');
  }
  randomFillSync(data, 0);
  return data;
}

// Implements an RFC 4122 version 4 random UUID.
// To improve performance, random data is generated in batches
// large enough to cover kBatchSize UUID's at a time. The uuidData
// buffer is reused. Each call to randomUUID() consumes 16 bytes
// from the buffer.

const kBatchSize = 128;
let uuidData;
let uuidNotBuffered;
let uuidBatch = 0;

let hexBytesCache;
function getHexBytes() {
  if (hexBytesCache === undefined) {
    hexBytesCache = new Array(256);
    for (let i = 0; i < hexBytesCache.length; i++) {
      const hex = NumberPrototypeToString(i, 16);
      hexBytesCache[i] = StringPrototypePadStart(hex, 2, '0');
    }
  }
  return hexBytesCache;
}

function serializeUUID(buf, offset = 0) {
  const kHexBytes = getHexBytes();
  // xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  return kHexBytes[buf[offset]] +
    kHexBytes[buf[offset + 1]] +
    kHexBytes[buf[offset + 2]] +
    kHexBytes[buf[offset + 3]] +
    '-' +
    kHexBytes[buf[offset + 4]] +
    kHexBytes[buf[offset + 5]] +
    '-' +
    kHexBytes[(buf[offset + 6] & 0x0f) | 0x40] +
    kHexBytes[buf[offset + 7]] +
    '-' +
    kHexBytes[(buf[offset + 8] & 0x3f) | 0x80] +
    kHexBytes[buf[offset + 9]] +
    '-' +
    kHexBytes[buf[offset + 10]] +
    kHexBytes[buf[offset + 11]] +
    kHexBytes[buf[offset + 12]] +
    kHexBytes[buf[offset + 13]] +
    kHexBytes[buf[offset + 14]] +
    kHexBytes[buf[offset + 15]];
}

function getBufferedUUID() {
  uuidData ??= secureBuffer(16 * kBatchSize);
  if (uuidData === undefined)
    throw new ERR_OPERATION_FAILED('Out of memory');

  if (uuidBatch === 0) randomFillSync(uuidData);
  uuidBatch = (uuidBatch + 1) % kBatchSize;
  return serializeUUID(uuidData, uuidBatch * 16);
}

function getUnbufferedUUID() {
  uuidNotBuffered ??= secureBuffer(16);
  if (uuidNotBuffered === undefined)
    throw new ERR_OPERATION_FAILED('Out of memory');
  randomFillSync(uuidNotBuffered);
  return serializeUUID(uuidNotBuffered);
}

function randomUUID(options) {
  if (options !== undefined)
    validateObject(options, 'options');
  const {
    disableEntropyCache = false,
  } = options || {};

  validateBoolean(disableEntropyCache, 'options.disableEntropyCache');

  return disableEntropyCache ? getUnbufferedUUID() : getBufferedUUID();
}

function createRandomPrimeJob(type, size, options) {
  validateObject(options, 'options');

  const {
    safe = false,
    bigint = false,
  } = options;
  let {
    add,
    rem,
  } = options;

  validateBoolean(safe, 'options.safe');
  validateBoolean(bigint, 'options.bigint');

  if (add !== undefined) {
    if (typeof add === 'bigint') {
      add = unsignedBigIntToBuffer(add, 'options.add');
    } else if (!isAnyArrayBuffer(add) && !isArrayBufferView(add)) {
      throw new ERR_INVALID_ARG_TYPE(
        'options.add',
        [
          'ArrayBuffer',
          'TypedArray',
          'Buffer',
          'DataView',
          'bigint',
        ],
        add);
    }
  }

  if (rem !== undefined) {
    if (typeof rem === 'bigint') {
      rem = unsignedBigIntToBuffer(rem, 'options.rem');
    } else if (!isAnyArrayBuffer(rem) && !isArrayBufferView(rem)) {
      throw new ERR_INVALID_ARG_TYPE(
        'options.rem',
        [
          'ArrayBuffer',
          'TypedArray',
          'Buffer',
          'DataView',
          'bigint',
        ],
        rem);
    }
  }

  const job = new RandomPrimeJob(type, size, safe, add, rem);
  job.result = bigint ? arrayBufferToUnsignedBigInt : (p) => p;
  return job;
}

function generatePrime(size, options, callback) {
  validateUint32(size, 'size', true);
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  validateCallback(callback);

  const job = createRandomPrimeJob(kCryptoJobAsync, size, options);
  job.ondone = (err, prime) => {
    if (err) {
      callback(err);
      return;
    }

    callback(
      undefined,
      job.result(prime));
  };
  job.run();
}

function generatePrimeSync(size, options = {}) {
  validateUint32(size, 'size', true);

  const job = createRandomPrimeJob(kCryptoJobSync, size, options);
  const { 0: err, 1: prime } = job.run();
  if (err)
    throw err;
  return job.result(prime);
}

function arrayBufferToUnsignedBigInt(arrayBuffer) {
  return BigInt(`0x${Buffer.from(arrayBuffer).toString('hex')}`);
}

function unsignedBigIntToBuffer(bigint, name) {
  if (bigint < 0) {
    throw new ERR_OUT_OF_RANGE(name, '>= 0', bigint);
  }

  const hex = bigint.toString(16);
  const padded = hex.padStart(hex.length + (hex.length % 2), 0);
  return Buffer.from(padded, 'hex');
}

function checkPrime(candidate, options = {}, callback) {
  if (typeof candidate === 'bigint')
    candidate = unsignedBigIntToBuffer(candidate, 'candidate');
  if (!isAnyArrayBuffer(candidate) && !isArrayBufferView(candidate)) {
    throw new ERR_INVALID_ARG_TYPE(
      'candidate',
      [
        'ArrayBuffer',
        'TypedArray',
        'Buffer',
        'DataView',
        'bigint',
      ],
      candidate
    );
  }
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  validateCallback(callback);
  validateObject(options, 'options');
  const {
    checks = 0,
  } = options;

  validateUint32(checks, 'options.checks');

  const job = new CheckPrimeJob(kCryptoJobAsync, candidate, checks);
  job.ondone = callback;
  job.run();
}

function checkPrimeSync(candidate, options = {}) {
  if (typeof candidate === 'bigint')
    candidate = unsignedBigIntToBuffer(candidate, 'candidate');
  if (!isAnyArrayBuffer(candidate) && !isArrayBufferView(candidate)) {
    throw new ERR_INVALID_ARG_TYPE(
      'candidate',
      [
        'ArrayBuffer',
        'TypedArray',
        'Buffer',
        'DataView',
        'bigint',
      ],
      candidate
    );
  }
  validateObject(options, 'options');
  const {
    checks = 0,
  } = options;

  validateUint32(checks, 'options.checks');

  const job = new CheckPrimeJob(kCryptoJobSync, candidate, checks);
  const { 0: err, 1: result } = job.run();
  if (err)
    throw err;

  return result;
}

module.exports = {
  checkPrime,
  checkPrimeSync,
  randomBytes,
  randomFill,
  randomFillSync,
  randomInt,
  getRandomValues,
  randomUUID,
  generatePrime,
  generatePrimeSync,
};
