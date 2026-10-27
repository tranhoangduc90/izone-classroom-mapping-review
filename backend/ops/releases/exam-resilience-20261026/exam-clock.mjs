// Public server time only; no roster, session, draft, grade or side effect.
// Independent of the student's clock and safe to query after browser sleep.
export function mountExamClock(app,{pool,limiter}) {
  const slugs=new Set(['term-test-1','term-test-2','mini-test-lesson-5','term-test-1-k56','term-test-2-k56','mini-test-k56']);
  app.get('/api/term-tests/:testSlug/clock',limiter,async(req,res,next)=>{
    res.set('Cache-Control','no-store, private');
    if(!slugs.has(req.params.testSlug))return res.status(404).json({ok:false,error:'TEST_NOT_FOUND'});
    // Deadlines are created by PostgreSQL. Read that clock as well, so an API
    // host's clock cannot disagree with the database on another machine.
    try{const {rows:[row]}=await pool.query('SELECT clock_timestamp() AS server_now');
      return res.json({ok:true,serverNow:new Date(row.server_now).toISOString()});
    }catch(error){next(error);}
  });
}
