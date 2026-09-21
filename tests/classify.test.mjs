import test from 'node:test';
import assert from 'node:assert/strict';
import { skipReason, isIdentifierLike, isStructuralText } from '../src/engine.mjs';

/** 反例优先：这些必须**不**被翻译 */
const DO_NOT_TRANSLATE = [
  'owner/repo',
  'feature-x',
  'v1.3.1',
  'src/index.js',
  'README.md',
  'pull_request',
  'MAX_RETRIES',
  'getElementById',
  'PullRequest',
  'https://example.com/a',
  'www.example.com',
  'someone@example.com',
  '12345',
  '2026-09-21',
  '#1f6feb',
  '2fa',
  'utf8',
];

for (const t of DO_NOT_TRANSLATE) {
  test(`不翻译：${JSON.stringify(t)}`, () => {
    assert.notEqual(skipReason(t, { maxLen: 200 }), null);
  });
}

/** 这些是 UI 名称，必须允许翻译（进入词典匹配） */
const SHOULD_TRANSLATE = [
  'Pull requests',
  'Issues',
  'Merge pull request',
  'Sign in',
  'Watch',
  'Public',
  'Updated',
  'New issue',
  'Create a new release',
  'Delete this repository',
];

for (const t of SHOULD_TRANSLATE) {
  test(`可以翻译：${JSON.stringify(t)}`, () => {
    assert.equal(skipReason(t, { maxLen: 200 }), null);
  });
}

test('超长文本视为正文，跳过', () => {
  assert.equal(skipReason('a'.repeat(201), { maxLen: 200 }), 'too-long');
  assert.equal(skipReason('a'.repeat(200), { maxLen: 200 }), null);
});

test('空文本跳过', () => {
  assert.equal(skipReason('', { maxLen: 200 }), 'empty');
  assert.equal(skipReason('   ', { maxLen: 200 }), 'empty');
});

test('isIdentifierLike / isStructuralText 的直接判定', () => {
  assert.equal(isIdentifierLike('owner/repo'), true);
  assert.equal(isIdentifierLike('owner/repo 说明'), false); // 含空白的交给词典
  assert.equal(isStructuralText('2026-09-21'), true);
  assert.equal(isStructuralText('Pull requests'), false);
});
