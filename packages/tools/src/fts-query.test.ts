import { test, expect } from 'vitest';
import { sanitizeFtsQuery } from './fts-query.js';

test('普通词包裹为字面短语', () => {
  expect(sanitizeFtsQuery('pnpm')).toBe('"pnpm"');
});

test('双引号转义为 ""', () => {
  expect(sanitizeFtsQuery('a"b')).toBe('"a""b"');
});

test('布尔操作符当字面(不解析)', () => {
  expect(sanitizeFtsQuery('foo OR bar')).toBe('"foo OR bar"');
});

test('中文原样包裹', () => {
  expect(sanitizeFtsQuery('中文搜索')).toBe('"中文搜索"');
});
