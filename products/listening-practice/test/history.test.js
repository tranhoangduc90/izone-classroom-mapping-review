import request from 'supertest';
import {fixture} from './helpers.js';
import {createApp} from '../src/app.js';
import {secret,uuid} from '../src/domain.js';
import {practiceHistoryContract} from '../../test-support/practice-history-contract.mjs';
practiceHistoryContract({product:'Listening',schema:'listening_practice',fixture,createApp,request,secret,uuid});
