import request from 'supertest';
import {fixture} from './helpers.js';
import {createApp} from '../src/app.js';
import {createTestObservationHub} from '../src/test-state-runtime.js';
import {uuid,secret,fail} from '../src/domain.js';
import {practiceStudentObservationContract} from '../../test-support/practice-student-observation-contract.mjs';
practiceStudentObservationContract({product:'Listening',schema:'listening_practice',fixture,createApp,request,createHub:createTestObservationHub,uuid,secret,fail});
