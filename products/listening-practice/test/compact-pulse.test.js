import {compactPulseContract} from '../../test-support/compact-pulse-contract.mjs';
import {fixture} from './helpers.js';
import {createApp} from '../src/app.js';
import {secret,uuid} from '../src/domain.js';
import request from 'supertest';
compactPulseContract({product:'Listening',schema:'listening_practice',fixture,createApp,secret,uuid,request});
