import { expect, test } from 'bun:test';
import { satisfies } from './remote-pods.ts';

test('CocoaPods requirement operators', () => {
  expect(satisfies('3.6.1', '3.6.1')).toBe(true);
  expect(satisfies('3.6.2', '= 3.6.1')).toBe(false);
  expect(satisfies('3.6.9', '~> 3.6.1')).toBe(true);
  expect(satisfies('3.7.0', '~> 3.6.1')).toBe(false);
  expect(satisfies('3.9.0', '~> 3.6')).toBe(true);
  expect(satisfies('4.0.0', '~> 3.6')).toBe(false);
  expect(satisfies('2.0', '>= 2')).toBe(true);
  expect(satisfies('1.9.9', '>= 2')).toBe(false);
  expect(satisfies('1.0', '< 1.0.1')).toBe(true);
  expect(satisfies('1.0', '!= 1.0.0')).toBe(false);
});
