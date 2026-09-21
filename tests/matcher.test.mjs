import test from 'node:test';
import assert from 'node:assert/strict';
import { normKey, splitEdges, matchLocal, compilePatterns, wordCount } from '../src/engine.mjs';

const dict = { 'pull requests': '拉取请求', issues: '议题', 'sign in': '登录' };
const patterns = compilePatterns([
  { re: '^(\\d+) commits? to (.+)$', out: '$1 次提交到 $2' },
  { re: '^(\\d+) commits?$', out: '$1 次提交' },
]);

test('normKey：NBSP、连续空白、大小写、空值', () => {
  assert.equal(normKey('  Pull\u00a0\u00a0Requests  '), 'pull requests');
  assert.equal(normKey('Pull\t\nRequests'), 'pull requests');
  assert.equal(normKey(null), '');
  assert.equal(normKey(undefined), '');
});

test('splitEdges：保留首尾空白', () => {
  const r = splitEdges('\n  Pull requests  ');
  assert.equal(r.lead, '\n  ');
  assert.equal(r.body, 'Pull requests');
  assert.equal(r.trail, '  ');
});

test('matchLocal：词典精确命中（忽略大小写与空白）', () => {
  assert.equal(matchLocal('Pull Requests', dict, patterns), '拉取请求');
  assert.equal(matchLocal('  issues ', dict, patterns), '议题');
  assert.equal(matchLocal('Sign In', dict, patterns), '登录');
  assert.equal(matchLocal('some unknown label', dict, patterns), null);
});

test('matchLocal：模板匹配带变量文本', () => {
  assert.equal(matchLocal('3 commits', dict, patterns), '3 次提交');
  assert.equal(matchLocal('12 commits to main', dict, patterns), '12 次提交到 main');
});

test('matchLocal：词典优先于模板', () => {
  const d = { '1 commits': '词典优先' };
  assert.equal(matchLocal('1 commits', d, patterns), '词典优先');
});

test('compilePatterns：跳过非法正则并去掉 g 标志', () => {
  const p = compilePatterns([{ re: '([', out: 'x' }, { re: '^a$', out: 'b', flags: 'g' }, null, { re: '^x$' }]);
  assert.equal(p.length, 1);
  assert.equal(p[0].re.global, false);
});

test('wordCount', () => {
  assert.equal(wordCount('a b c'), 3);
  assert.equal(wordCount('   '), 0);
  assert.equal(wordCount(''), 0);
});
