import {compactPulseContract} from '../../test-support/compact-pulse-contract.mjs';
import {fixture} from './helpers.js';
import {createApp} from '../src/app.js';
import {secret,uuid} from '../src/domain.js';
import request from 'supertest';
compactPulseContract({product:'Reading',schema:'reading_practice',fixture,createApp,secret,uuid,request});
