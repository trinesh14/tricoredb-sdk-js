'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { TriCoreError } = require('tricoredb');

const api = require('tricoredb');
const { encodeBody, sqlParam, bindParams } = api;

const suite = test;

suite('BigInt parameters survive the frame body exactly', () => {
  test('BigInt values encode as exact JSON numbers without losing digits', () => {
    const big = 9223372036854775807n;
    const body = encodeBody({ Sql: { Query: { sql: 'SELECT ?', params: [sqlParam(big)] } } });
    assert.match(body, /9223372036854775807/);
    assert.doesNotMatch(body, /"9223372036854775807"/);
    assert.doesNotMatch(body, /9223372036854775808/);

    const negative = encodeBody({ params: [sqlParam(-9223372036854775808n)] });
    assert.match(negative, /-9223372036854775808/);

    const several = encodeBody({ params: [1n, 2n, 3n].map(sqlParam) });
    const parsed = JSON.parse(several);
    assert.equal(parsed.params.length, 3);
    assert.match(several, /\[1,2,3\]/);
  });

  test('integer-valued numbers outside the safe range are refused by name', () => {
    assert.throws(() => sqlParam(9007199254740993), /BigInt/i);
    assert.throws(() => sqlParam(-9007199254740993), /BigInt/i);
    assert.equal(sqlParam(42), 42);
    assert.equal(sqlParam(-1), -1);
    assert.equal(sqlParam(9007199254740991), 9007199254740991);
    assert.equal(sqlParam(1.5), 1.5);
    assert.equal(sqlParam(1e300), 1e300);
    assert.equal(sqlParam(2 ** 70), 2 ** 70);
    assert.throws(() => sqlParam(2 ** 53 + 2), /BigInt/i);
    assert.throws(() => sqlParam(9223372036854774784), /BigInt/i);
  });

  test('bytes bind as BLOB hex and views send only their own window', () => {
    const bytes = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x27, 0x5c, 0x68, 0x69, 0x00]);
    assert.equal(sqlParam(bytes), '0x0001fffe275c686900');
    assert.notEqual(bytes.toString('utf8'), '\u0000\u0001\u00ff\u00fe\'\\hi\u0000');
    assert.equal(sqlParam(new Uint8Array([0xde, 0xad, 0xbe, 0xef])), '0xdeadbeef');
    assert.equal(sqlParam(Buffer.alloc(0)), '0x');
    assert.equal(sqlParam(Buffer.from([1, 2, 3, 4, 5, 6]).subarray(2, 4)), '0x0304');

    const body = encodeBody({ params: [sqlParam(bytes)] });
    assert.equal(body, '{"params":["0x0001fffe275c686900"]}');
    assert.doesNotMatch(body, /"type"/);
    assert.equal(sqlParam(bytes), `0x${bytes.toString('hex')}`);
  });

  test('client-side literal rendering stays consistent with server-side binding', () => {
    const bytes = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x27, 0x5c, 0x68, 0x69, 0x00]);
    assert.equal(bindParams('INSERT INTO t VALUES (?, ?)', [1, bytes]), "INSERT INTO t VALUES (1, '0x0001fffe275c686900')");
    assert.equal(bindParams('INSERT INTO t VALUES (?)', [Buffer.alloc(0)]), "INSERT INTO t VALUES ('0x')");
    assert.equal(bindParams('INSERT INTO t VALUES (?)', [new Uint8Array([0xde, 0xad])]), "INSERT INTO t VALUES ('0xdead')");
    assert.equal(bindParams('SELECT ?', [bytes]), `SELECT '${sqlParam(bytes)}'`);
  });

  test('a Date binds as an ISO instant', () => {
    const d = new Date(Date.UTC(2026, 0, 31, 12, 0, 0));
    assert.equal(sqlParam(d), '2026-01-31T12:00:00.000Z');
  });

  test('everything else is unchanged', () => {
    assert.equal(sqlParam(null), null);
    assert.equal(sqlParam(true), true);
    assert.equal(sqlParam('x'), 'x');
    const plain = encodeBody({ a: 1, b: 'two', c: [null, false] });
    assert.equal(plain, JSON.stringify({ a: 1, b: 'two', c: [null, false] }));
    const tricky = encodeBody({ s: 'deadbeefdeadbeefde:0', n: 7n });
    const parsed = JSON.parse(tricky);
    assert.equal(parsed.s, 'deadbeefdeadbeefde:0');
    assert.equal(parsed.n, 7);
  });
});
