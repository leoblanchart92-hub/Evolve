import assert from 'node:assert/strict';
import { test } from 'node:test';
import { versionCompare } from '../src/main/update.js';
test('version comparison semver basic',()=>{assert.equal(versionCompare('0.3.2','0.3.1'),1);assert.equal(versionCompare('v1.0.0','0.9.9'),1);assert.equal(versionCompare('0.3.1','0.3.1'),0);assert.equal(versionCompare('0.3.0','0.3.1'),-1);});
