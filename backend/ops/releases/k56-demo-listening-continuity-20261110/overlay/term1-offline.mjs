import{createK56Offline}from'./term1-skill-offline-core.mjs';
const api=createK56Offline({"slug":"term-test-1-k56","policy":"term1-offline-v1","tablePrefix":"term1","taskId":"task2","taskNumber":2,"flag":"TERM1_OFFLINE_NEW_ENABLED"});
export const {SLUG,POLICY,schema,canonical,digest,permitFor,validateTimeline}=api;
export const registerTerm1Offline=api.registerOffline;
