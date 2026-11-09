import{createK56Offline}from'./k56-offline-core.mjs';
const api=createK56Offline({"slug":"term-test-2-k56","policy":"term2-offline-v1","tablePrefix":"term2","taskId":"task1","taskNumber":1,"flag":"TERM2_OFFLINE_NEW_ENABLED"});
export const {SLUG,POLICY,schema,canonical,digest,permitFor,validateTimeline}=api;
export const registerTerm2Offline=api.registerOffline;
