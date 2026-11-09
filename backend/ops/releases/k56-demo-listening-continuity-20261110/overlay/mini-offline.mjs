import {readFileSync} from 'node:fs';
import {createK56Offline} from './k56-offline-core.mjs';
import {isBlank} from './term1-blank.mjs';

const profile={slug:'mini-test-k56',policy:'mini-k56-offline-v1',tablePrefix:'mini_k56',taskId:'task2',taskNumber:2};
const {schema,registerOffline}=createK56Offline(profile);
export {schema};

function allowNew(mode,classCode){
 const paper=mode==='answer_sheet',path=process.env.MINI_K56_OFFLINE_CONFIG_FILE;
 if(!path)return process.env[paper?'MINI_K56_PAPER_OFFLINE_NEW':'MINI_K56_CBT_OFFLINE_NEW']==='true';
 try{
  const config=JSON.parse(readFileSync(path,'utf8'));
  return config[paper?'paper':'cbt']===true&&(config.classes===null||
   (Array.isArray(config.classes)&&config.classes.includes(classCode.trim().toUpperCase())));
 }catch{return false;}
}

export function registerMiniOffline(router,dependencies){
 return registerOffline(router,{...dependencies,allowNew});
}

export async function hasMiniOfflineRun(client,slug,attemptId){
 if(slug!==profile.slug)return false;
 const result=await client.query('SELECT 1 FROM assessment.mini_k56_offline_run WHERE attempt_id=$1 AND policy=$2',
  [attemptId,profile.policy]);
 return result.rows.length>0;
}

export async function canonicalMiniWriting(client,attempt){
 if(attempt.test_slug!==profile.slug||!attempt.writing_submitted_at)return null;
 const row=(await client.query('SELECT state FROM assessment.mini_k56_offline_run WHERE attempt_id=$1 AND policy=$2',
  [attempt.id,profile.policy])).rows[0];
 if(!row?.state?.writing?.sealed)return null;
 if(typeof attempt.writing_task_2!=='string'||Boolean(row.state.writing.blank)!==isBlank(attempt.writing_task_2))
  throw Object.assign(Error('Bài Writing đã khóa chưa khớp; cần đối soát.'),{code:'WRITING_CANONICAL_MISSING'});
 return {task2:attempt.writing_task_2,blank:row.state.writing.blank===true};
}
