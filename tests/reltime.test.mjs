import test from 'node:test';
import assert from 'node:assert/strict';
import { formatRelativeTime } from '../src/engine.mjs';

const now = new Date('2026-09-21T12:00:00Z');

test('过去时间：小时/天/月/年', () => {
  assert.match(formatRelativeTime('2026-09-21T09:00:00Z', now), /小时前/);
  assert.match(formatRelativeTime('2026-09-18T12:00:00Z', now), /天前/);
  assert.match(formatRelativeTime('2026-06-21T12:00:00Z', now), /个月前/);
  assert.match(formatRelativeTime('2023-09-21T12:00:00Z', now), /年前/);
});

test('未来时间：以「后」结尾', () => {
  assert.equal(formatRelativeTime('2026-09-28T12:00:00Z', now), '下周');
  assert.match(formatRelativeTime('2026-10-12T12:00:00Z', now), /周后/);
  assert.match(formatRelativeTime('2029-09-21T12:00:00Z', now), /年后/);
});

test('numeric:auto 的中文特例', () => {
  assert.equal(formatRelativeTime('2026-09-21T12:00:00Z', now), '现在');
  assert.equal(formatRelativeTime('2026-09-20T12:00:00Z', now), '昨天');
  assert.equal(formatRelativeTime('2025-09-21T12:00:00Z', now), '去年');
});

test('非法日期返回 null', () => {
  assert.equal(formatRelativeTime('not-a-date', now), null);
  assert.equal(formatRelativeTime(undefined, now), null);
  assert.equal(formatRelativeTime(null, now), null);
});
