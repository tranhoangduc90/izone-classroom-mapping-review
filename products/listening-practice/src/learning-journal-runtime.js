import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// A small native bridge: off never imports the shared journal library.
export async function startPracticeJournal({productId,origins,env=process.env}){
 if(env.EXAM_JOURNAL_ENABLED!=='1')return null;
 try{
  const url=pathToFileURL(resolve(env.EXAM_JOURNAL_LIBRARY_ROOT||'/opt/exam-journal','adapters/learning-runtime.mjs'));
  const {startLearningJournalRuntime}=await import(url.href);
  return await startLearningJournalRuntime({productId,env,allowedOrigins:origins,
   onHealth:value=>console.error(JSON.stringify(value))});
 }catch{console.error(JSON.stringify({type:'learning_journal_health',status:'degraded',errorCode:'LEARNING_JOURNAL_START_FAILED'}));return null;}
}
export async function stopPracticeJournal(runtime){
 try{return await runtime?.close();}
 catch{console.error(JSON.stringify({type:'learning_journal_health',status:'degraded',errorCode:'LEARNING_JOURNAL_SHUTDOWN_UNKNOWN'}));return{status:'shutdown_unknown'};}
}
