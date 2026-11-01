import request from 'supertest';
import {fixture} from './helpers.js';
import {createApp} from '../src/app.js';
import {createTestObservationHub} from '../src/test-state-runtime.js';
import {uuid,secret} from '../src/domain.js';
import {practiceObservationContract} from '../../test-support/practice-observation-contract.mjs';
practiceObservationContract({product:'Reading',schema:'reading_practice',fixture,createApp,request,createHub:createTestObservationHub,uuid,secret});
