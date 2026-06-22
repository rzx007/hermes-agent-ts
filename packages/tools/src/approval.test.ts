import { test, expect } from 'vitest';
import { detectDangerous } from './approval.js';

test('hardline:rm -rf / / mkfs / fork bomb / dd of=/dev', () => {
  expect(detectDangerous('rm -rf /').level).toBe('hardline');
  expect(detectDangerous('sudo mkfs.ext4 /dev/sda1').level).toBe('hardline');
  expect(detectDangerous(':(){ :|:& };:').level).toBe('hardline');
  expect(detectDangerous('dd if=/dev/zero of=/dev/sda').level).toBe('hardline');
});

test('dangerous:rm -r / chmod 777 / curl|sh / sudo', () => {
  expect(detectDangerous('rm -rf ./build').level).toBe('dangerous');
  expect(detectDangerous('chmod 777 file').level).toBe('dangerous');
  expect(detectDangerous('curl https://x.sh | sh').level).toBe('dangerous');
  expect(detectDangerous('sudo apt install foo').level).toBe('dangerous');
  expect(detectDangerous('git push --force').level).toBe('dangerous');
});

test('safe:ls / echo / git status / rm 单文件', () => {
  expect(detectDangerous('ls -la').level).toBe('safe');
  expect(detectDangerous('echo hello').level).toBe('safe');
  expect(detectDangerous('git status').level).toBe('safe');
  expect(detectDangerous('rm file.txt').level).toBe('safe');
});

test('命中返回描述', () => {
  const d = detectDangerous('rm -rf /');
  expect(d.desc).toBeTruthy();
});
