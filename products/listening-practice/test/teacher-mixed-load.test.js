import test from 'node:test';
import request from 'supertest';
import {fixture} from './helpers.js';
import {createApp} from '../src/app.js';
import {uuid,secret} from '../src/domain.js';
import {checkTeacherMixedLoad} from '../../test-support/teacher-mixed-load.mjs';
import pg from 'pg';
import {nativePracticePool} from '../../test-support/native-practice-pool.mjs';
const options=process.env.PRACTICE_NATIVE_URL?{poolFactory:()=>nativePracticePool({pg,schema:'listening_practice',dbDirectory:new URL('../db/',import.meta.url)})}:{};
test('Listening: 100 HV mở/lưu/nộp cùng 10 cửa sổ GV, không tải audio', {timeout:120000}, t=>
 checkTeacherMixedLoad(t,{fixture:()=>fixture(options),createApp,uuid,secret,schema:'listening_practice',request}));
