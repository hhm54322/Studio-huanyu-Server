import {before,after,test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdtemp,readFile,writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import sharp from 'sharp'
import {pool,closePool} from '../../db/pool.js'
import {baseMigrationSql} from '../../db/migrate.js'
import {migrateExpertReview} from '../migration.js'
import {registerExpertReviewRoutes} from '../../routes/expertReview.js'
import {hashPassword} from '../security.js'
import {appendExpertKnowledge,retrieveExpertKnowledge,withExpertKnowledge} from '../knowledge.js'
import {config} from '../../config.js'
import {imagePage} from '../attachments.js'
import {reportModules,inputView} from '../cases.js'
import {requestMedicalChatCompletion} from '../../report/medicalLlmProvider.js'

// Dedicated disposable PostgreSQL only. Never truncate or seed a business DB.
assert.match(process.env.DATABASE_URL||'',/huanyu_expert_qa/,'Test database must be explicitly isolated')
const app=Fastify({logger:false}),origin='http://127.0.0.1:5190'
const originalFetch=globalThis.fetch
const applicabilityResponse=(body:any)=>{
 const task=body.messages?.map((m:any)=>{try{return JSON.parse(m.content)}catch{return null}}).find((m:any)=>m?.task==='expert_knowledge_applicability')
 if(!task)return undefined
 return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({results:task.candidates.map((k:any)=>({id:k.id,decision:'applicable',relevance:0.95,supportingQuotes:[task.currentCase],reason:'conditions_supported',conflictsWith:[]}))})}}]}),{headers:{'content-type':'application/json'}})
}
let adminId:string,expertId:string,otherId:string,caseId:string,proId:string,uploadFile:any,admin:any,expert:any,other:any,detail:any,revision:number
const report=JSON.parse(await readFile(path.resolve('../Studio-huanyu-Client/prototypes/expert-review/samples.json'),'utf8'))
const login=async(username:string,password='admin123')=>{const r=await app.inject({method:'POST',url:'/api/expert/session',headers:{origin},payload:{username,password}});assert.equal(r.statusCode,200);return {cookie:String(r.headers['set-cookie']).split(';')[0],csrf:r.json().csrf}}
const call=async(method:any,url:string,payload?:any,s=expert)=>app.inject({method,url:`/api/expert${url}`,headers:{cookie:s.cookie,origin,'x-expert-csrf':s.csrf},payload})
before(async()=>{
 process.env.EXPERT_REVIEW_ENABLED='true'
 process.env.EXPERT_KNOWLEDGE_REQUIRE_CONFIRMATION='true'
 config.medicalLlmApiKey='isolated-qa-only';config.medicalLlmBaseUrl='http://127.0.0.1:1/isolated-qa';config.medicalLlmStream=false
 globalThis.fetch=async(_url,init)=>{const response=applicabilityResponse(JSON.parse(String(init?.body)));if(response)return response;throw Error('QA blocks all external model requests')}
 const uploadRoot=await mkdtemp(path.join(os.tmpdir(),'huanyu-expert-qa-'));config.uploadDir=uploadRoot
 await pool.query(baseMigrationSql);await migrateExpertReview(pool)
 assert.match(config.databaseUrl,/\/huanyu_expert_qa(?:\?|$)/,'Refuse to seed/reset any business database')
 await pool.query('TRUNCATE expert_audit,expert_generation_knowledge,expert_attachment_previews,expert_knowledge,expert_reviews,expert_case_versions,expert_sessions,expert_accounts,report_submissions,professional_report_submissions CASCADE')
 const hash=await hashPassword('admin123')
 for(const [username,role] of [['admin','admin'],['expert','expert'],['other','expert'],['confirmer','knowledge_confirmer']] as const){await pool.query('INSERT INTO expert_accounts(username,display_name,password_hash,role,test_account) VALUES($1,$1,$2,$3,true) ON CONFLICT(username) DO NOTHING',[username,hash,role])}
 const accounts=(await pool.query('SELECT id,username FROM expert_accounts')).rows;adminId=accounts.find(r=>r.username==='admin')!.id;expertId=accounts.find(r=>r.username==='expert')!.id;otherId=accounts.find(r=>r.username==='other')!.id
 const fixture=await sharp({create:{width:500,height:600,channels:3,background:'#fff'}}).composite([{input:Buffer.from('<svg width="500" height="600"><rect x="20" y="20" width="200" height="50" fill="#f00"/><rect x="20" y="200" width="200" height="50" fill="#00f"/></svg>')}]).png().toBuffer()
 const filename=path.join(uploadRoot,'patient-image.png');await writeFile(filename,fixture)
 uploadFile={originalName:'PRIVATE_PATIENT_test.png',mimeType:'image/png',size:fixture.length,relativePath:filename,storedName:'never-expose.png'}
 caseId=randomUUID();proId=randomUUID()
 report.free.id='rpt_qa_'+caseId;report.professional.id='pro_qa_'+proId
 await pool.query(`INSERT INTO report_submissions(id,submission_no,locale,full_name,gender,visit_purpose,chief_complaint,email,phone,report_status,report_result) VALUES($1,$2,'zh','PRIVATE_PATIENT','female','breast_cancer','术后复查，需核对病理分期。','hidden@example.com','+60123456789','generated',$3::jsonb)`,[caseId,report.free.id,JSON.stringify(report.free)])
 await pool.query(`INSERT INTO professional_report_submissions(id,submission_no,locale,full_name,gender,visit_purpose,chief_complaint,report_status,report_result,uploaded_files,parsed_files) VALUES($1,$2,'zh','PRIVATE_PATIENT','female','breast_cancer','右侧乳腺癌术后复查，待病理分期核实。','generated',$3::jsonb,$4::jsonb,$5::jsonb)`,[proId,report.professional.id,JSON.stringify(report.professional),JSON.stringify([uploadFile]),JSON.stringify([{originalName:uploadFile.originalName,text:'PRIVATE_PATIENT\n检查日期：2024-09-20\nER 80%',summary:'PRIVATE_PATIENT 检查日期2024-09-20 ER80%',metadata:{medicalFacts:{dates:['2024-09-20'],indicators:[{name:'ER',value:'80%',evidence:'ER80%'}]}}}])])
 await registerExpertReviewRoutes(app);await app.ready();admin=await login('admin');expert=await login('expert');other=await login('other')
})
after(async()=>{globalThis.fetch=originalFetch;await app.close();await closePool()})
test('unregistered and unauthenticated requests are denied',async()=>{
 const r=await app.inject({method:'GET',url:'/api/expert/cases'});assert.equal(r.statusCode,401)
 const no=await app.inject({method:'POST',url:'/api/expert/session',headers:{origin},payload:{username:'not-an-expert',password:'admin123'}});assert.equal(no.statusCode,401)
 const badOrigin=await app.inject({method:'POST',url:'/api/expert/session',headers:{origin:'https://evil.example'},payload:{username:'admin',password:'admin123'}});assert.equal(badOrigin.statusCode,403)
})
test('live cases/input/report are read from DB and identity/path is withheld',async()=>{
 const list=await call('GET','/cases');assert.ok(list.json().items.some((r:any)=>r.id===caseId))
 const r=await call('GET',`/cases/free/${caseId}`);assert.equal(r.statusCode,200);detail=r.json().case;revision=r.json().review.version
 assert.equal(detail.input.groups.flatMap((g:any)=>g.fields).find((f:any)=>f.key==='chief_complaint').value,'术后复查，需核对病理分期。')
 assert.ok(!JSON.stringify(r.json()).includes('PRIVATE_PATIENT'));assert.ok(!JSON.stringify(r.json()).includes('hidden@example.com'))
 const p=await call('GET',`/cases/professional/${proId}`);assert.ok(!JSON.stringify(p.json()).includes('relativePath'));assert.ok(!JSON.stringify(p.json()).includes('PRIVATE_PATIENT_test'))
})
test('CSRF, ownership, unknown nodes, optimistic locking are enforced',async()=>{
 const d=(await call('GET',`/cases/free/${caseId}`)).json();const id=d.review.id
 const csrf=await app.inject({method:'PUT',url:`/api/expert/reviews/${id}`,headers:{cookie:expert.cookie,origin},payload:{version:d.review.version,notes:[],confirmed:[],drafts:{}}});assert.equal(csrf.statusCode,403)
 const ownership=await call('PUT',`/reviews/${id}`,{version:d.review.version,notes:[],confirmed:[],drafts:{}},other);assert.equal(ownership.statusCode,404)
 const unknown=await call('PUT',`/reviews/${id}`,{version:d.review.version,notes:[{id:randomUUID(),module:'cost',target:'forged-node',decision:'认可'}],confirmed:[],drafts:{}});assert.equal(unknown.statusCode,400)
 const saved=await call('PUT',`/reviews/${id}`,{version:d.review.version,notes:[],confirmed:[],drafts:{}});assert.equal(saved.statusCode,200)
 const conflict=await call('PUT',`/reviews/${id}`,{version:d.review.version,notes:[],confirmed:[],drafts:{}});assert.equal(conflict.statusCode,409)
})
test('incomplete cannot submit; complete review locks and pending knowledge is never retrieved',async()=>{
 let d=(await call('GET',`/cases/free/${caseId}`)).json()
 const incomplete=await call('POST',`/reviews/${d.review.id}/submit`,{version:d.review.version,attest:true});assert.equal(incomplete.statusCode,400)
 const notes=d.case.modules.map((m:any)=>({id:randomUUID(),module:m.key,target:m.key,decision:'认可',text:'已核对本模块',replacement:'',evidence:''}))
 const cost=notes.find((n:any)=>n.module==='cost');Object.assign(cost,{decision:'修改',text:'费用需要以医生面诊复核为准',replacement:'来华医疗费用需结合病理分期和最终医院正式报价，不应承诺固定费用。',evidence:'医院正式预审报价及病理复核',knowledge:{candidate:true,title:'乳腺癌费用复核',applicability:'已确诊乳腺癌并拟来华评估',exclusions:'诊断未确认或急症需先当地处理',keywords:['乳腺癌'],requiredTerms:['术后'],excludedTerms:['未确诊']}})
 const saved=await call('PUT',`/reviews/${d.review.id}`,{version:d.review.version,notes,confirmed:d.case.modules.map((m:any)=>m.key),drafts:{}});assert.equal(saved.statusCode,200)
 const done=await call('POST',`/reviews/${d.review.id}/submit`,{version:saved.json().review.version,attest:true});assert.equal(done.statusCode,200);assert.equal(done.json().review.status,'submitted')
 const repeat=await call('POST',`/reviews/${d.review.id}/submit`,{version:saved.json().review.version,attest:true});assert.equal(repeat.statusCode,200)
 const count=await pool.query('SELECT count(*) FROM expert_knowledge WHERE review_id=$1',[d.review.id]);assert.equal(Number(count.rows[0].count),1)
 const locked=await call('PUT',`/reviews/${d.review.id}`,{version:done.json().review.version,notes,confirmed:[],drafts:{}});assert.equal(locked.statusCode,409)
 assert.deepEqual(await retrieveExpertKnowledge('breast_cancer','乳腺癌术后'),[])
 const source=await pool.query('SELECT report_result FROM report_submissions WHERE id=$1',[caseId]);assert.deepEqual(source.rows[0].report_result,report.free)
})
test('knowledge approval is denied for experts/admin and reserved confirmer is disabled',async()=>{
 const id=(await pool.query('SELECT id FROM expert_knowledge LIMIT 1')).rows[0].id
 assert.equal((await call('POST',`/knowledge/${id}/approve`,{},admin)).statusCode,403)
 const confirmer=await login('confirmer');assert.equal((await call('POST',`/knowledge/${id}/approve`,{},confirmer)).statusCode,409)
})
test('future retrieval requires published, in-date, condition-matched version; async context isolation and provenance',async()=>{
 const k=(await pool.query('SELECT * FROM expert_knowledge LIMIT 1')).rows[0],confirmer=(await pool.query("SELECT id FROM expert_accounts WHERE username='confirmer'")).rows[0].id
 await pool.query(`UPDATE expert_knowledge SET status='approved',confirmed_by=$2,confirmed_at=now(),valid_until=now()+interval '1 month' WHERE id=$1`,[k.id,confirmer])
 assert.equal((await retrieveExpertKnowledge('breast_cancer','乳腺癌术后')).length,1)
 assert.equal((await retrieveExpertKnowledge('lung_cancer','肺癌术后')).length,0)
 assert.equal((await retrieveExpertKnowledge('breast_cancer','乳腺癌术后，未确诊')).length,0)
 assert.equal((await retrieveExpertKnowledge('breast_cancer','乳腺癌')).length,0)
 const messages=[{role:'system' as const,content:'baseline'}]
 const results=await Promise.all([withExpertKnowledge('free','qa-gen-a','breast_cancer','乳腺癌术后',async()=>appendExpertKnowledge(messages)),withExpertKnowledge('free','qa-gen-b','lung_cancer','肺癌',async()=>appendExpertKnowledge(messages))])
 assert.equal(results[0].length,2);assert.equal(results[1].length,1);assert.equal(appendExpertKnowledge(messages).length,1)
 const trace=await pool.query("SELECT * FROM expert_generation_knowledge WHERE submission_no='qa-gen-a'");assert.equal(trace.rows[0].citations[0].id,k.id)
 await pool.query(`UPDATE expert_knowledge SET valid_until=now()-interval '1 second' WHERE id=$1`,[k.id]);assert.equal((await retrieveExpertKnowledge('breast_cancer','乳腺癌术后')).length,0)
 await pool.query(`UPDATE expert_knowledge SET status='withdrawn',valid_until=NULL WHERE id=$1`,[k.id]);assert.equal((await retrieveExpertKnowledge('breast_cancer','乳腺癌术后')).length,0)
})
test('direct expert submission publishes knowledge; real model request receives guidance; future confirmation and withdrawal stop reuse',async()=>{
 process.env.EXPERT_KNOWLEDGE_REQUIRE_CONFIRMATION='false'
 try{
  const d=(await call('GET',`/cases/free/${caseId}`,undefined,admin)).json()
  const notes=d.case.modules.map((m:any)=>({id:randomUUID(),module:m.key,target:m.key,decision:'认可',text:'已核对'}))
  Object.assign(notes.find((n:any)=>n.module==='cost'),{decision:'修改',text:'预算必须复核',replacement:'直接发布测试：费用仅作范围参考，以医院正式报价为准。',evidence:'专家审核的医院报价规则',knowledge:{candidate:true,title:'直接发布费用原则',applicability:'乳腺癌术后评估',exclusions:'诊断未确认',keywords:['乳腺癌'],requiredTerms:['术后'],excludedTerms:['未确诊']}})
  const saved=await call('PUT',`/reviews/${d.review.id}`,{version:d.review.version,notes,confirmed:d.case.modules.map((m:any)=>m.key),drafts:{}},admin);assert.equal(saved.statusCode,200)
  assert.equal((await retrieveExpertKnowledge('breast_cancer','乳腺癌术后')).length,0,'Draft must never be used')
  const done=await call('POST',`/reviews/${d.review.id}/submit`,{version:saved.json().review.version,attest:true},admin);assert.equal(done.statusCode,200)
  const k=(await pool.query('SELECT * FROM expert_knowledge WHERE review_id=$1',[d.review.id])).rows[0];assert.equal(k.status,'expert_published');assert.equal(k.confirmed_by,null)
  assert.equal((await call('GET','/session',undefined,admin)).json().knowledgePolicy.directFeedbackEnabled,true)
  assert.equal((await call('GET','/knowledge',undefined,admin)).json().publicationEnabled,true)
  assert.equal((await retrieveExpertKnowledge('breast_cancer','乳腺癌术后'))[0].id,k.id)
  const oldFetch=globalThis.fetch,oldKey=config.medicalLlmApiKey,oldBase=config.medicalLlmBaseUrl,oldStream=config.medicalLlmStream
  let request:any
  try{
   config.medicalLlmApiKey='isolated-qa-not-a-real-key';config.medicalLlmBaseUrl='http://127.0.0.1:1/isolated-qa';config.medicalLlmStream=false
   globalThis.fetch=async(_input,init)=>{const body=JSON.parse(String(init?.body));const verified=applicabilityResponse(body);if(verified)return verified;request=body;return new Response(JSON.stringify({choices:[{message:{content:'{"result":"isolated simulated response"}'}}]}),{headers:{'content-type':'application/json'}})}
   const output=await withExpertKnowledge('professional','qa-direct-provider','breast_cancer','乳腺癌术后',()=>requestMedicalChatCompletion({messages:[{role:'system',content:'只以当前病例证据为准'}],temperature:0}))
   assert.ok(output?.includes('isolated'));assert.ok(JSON.stringify(request.messages).includes(k.guidance));assert.ok(JSON.stringify(request.messages).includes('expert_submission'))
  }finally{globalThis.fetch=oldFetch;config.medicalLlmApiKey=oldKey;config.medicalLlmBaseUrl=oldBase;config.medicalLlmStream=oldStream}
  const trace=(await pool.query("SELECT citations,status FROM expert_generation_knowledge WHERE submission_no='qa-direct-provider'")).rows[0];assert.equal(trace.status,'completed');assert.equal(trace.citations[0].id,k.id);assert.equal(trace.citations[0].publicationBasis,'expert_submission')
  process.env.EXPERT_KNOWLEDGE_REQUIRE_CONFIRMATION='true';assert.deepEqual(await retrieveExpertKnowledge('breast_cancer','乳腺癌术后'),[])
  process.env.EXPERT_KNOWLEDGE_REQUIRE_CONFIRMATION='false'
  assert.equal((await call('POST',`/knowledge/${k.id}/withdraw`,{},other)).statusCode,404)
  assert.equal((await call('POST',`/knowledge/${k.id}/withdraw`,{},admin)).statusCode,200);assert.deepEqual(await retrieveExpertKnowledge('breast_cancer','乳腺癌术后'),[])
  assert.equal((await call('POST',`/knowledge/${k.id}/withdraw`,{},admin)).statusCode,200)
 }finally{process.env.EXPERT_KNOWLEDGE_REQUIRE_CONFIRMATION='true'}
})
test('attachments fail closed until privacy confirmation; raw is role-restricted; irreversible mask preserves clinical pixels',async()=>{
 const d=(await call('GET',`/cases/professional/${proId}`)).json(),v=d.case.id
 const pending=await call('GET',`/cases/${v}/files/0/pages/1`);assert.equal(pending.statusCode,409)
 const raw=await call('GET',`/curation/${v}/files/0/pages/1`);assert.equal(raw.statusCode,403)
 const info=await call('GET',`/curation/${v}/files/0`,undefined,admin);assert.equal(info.statusCode,200)
 const invalid=await call('POST',`/curation/${v}/files/0`,{...info.json(),attest:true,pages:[],redactedText:''},admin);assert.equal(invalid.statusCode,400)
 const unseen=await call('POST',`/curation/${v}/files/0`,{revision:info.json().revision,sourceHash:info.json().sourceHash,attest:true,pages:[{page:1,masks:[]}],redactedText:''},admin);assert.equal(unseen.statusCode,400);assert.equal(unseen.json().error,'CURATION_NOT_VIEWED')
 const original=await call('GET',`/curation/${v}/files/0/pages/1`,undefined,admin);assert.equal(original.statusCode,200)
 const done=await call('POST',`/curation/${v}/files/0`,{revision:info.json().revision,sourceHash:info.json().sourceHash,attest:true,pages:[{page:1,masks:[{x:0,y:0,width:.5,height:.2}]}],redactedText:'PRIVATE_PATIENT 检查日期2024-09-20 ER80%'},admin);assert.equal(done.statusCode,200)
 const view=await call('GET',`/cases/${v}/files/0/pages/1`);assert.equal(view.statusCode,200);assert.match(view.headers['cache-control'] as string,/no-store/)
 const pixels=await sharp(view.rawPayload).raw().toBuffer({resolveWithObject:true});const p=(x:number,y:number)=>Array.from(pixels.data.subarray((y*pixels.info.width+x)*pixels.info.channels,(y*pixels.info.width+x)*pixels.info.channels+3))
 assert.ok(p(50,40).every(c=>c<8),'Sensitive region should be black');assert.ok(p(50,220)[2]>220,'Clinical region should retain blue data')
 const again=(await call('GET',`/cases/professional/${proId}`)).json();assert.ok(!JSON.stringify(again).includes('PRIVATE_PATIENT'));assert.ok(again.case.input.uploads[0].text.includes('2024-09-20'))
 const traversal=await call('GET',`/cases/${v}/files/99/pages/1`);assert.equal(traversal.statusCode,400)
})
test('legacy free module map and non-sensitive city/regions use source input, not prototype defaults',()=>{
 const legacy=structuredClone(report.free);delete legacy.layoutSections
 assert.deepEqual(reportModules('free',legacy).map(m=>m.key),['overview','fallback-8','fallback-9','fallback-10','fallback-11','fallback-12','fallback-13','fallback-14'])
 const view=inputView({full_name:'PRIVATE_PATIENT',city:'吉隆坡',selected_regions:['europe'],uploaded_files:[],parsed_files:[]},['PRIVATE_PATIENT'])
 assert.equal(view.sourceInfo.fullName,'***');assert.equal(view.sourceInfo.city,'吉隆坡');assert.deepEqual(view.sourceInfo.selectedRegions,['europe'])
})
test('uploaded text and PDF originals render per page; unsupported formats and encodings fail closed',async()=>{
 const text=await imagePage(Buffer.from(Array.from({length:50},(_,i)=>`原始资料第${i+1}行 ER 80%`).join('\n')),'text/plain',2)
 assert.equal(text.pages,2);assert.equal((await sharp(text.buffer).metadata()).width,1800)
 await assert.rejects(()=>imagePage(Buffer.from([0xff,0x80]),'text/plain',1),/文本编码/)
 await assert.rejects(()=>imagePage(Buffer.from('x'),'application/dicom',1),/转换/)
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 600] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>','<< /Length 50 >>\nstream\nBT /F1 20 Tf 30 500 Td (Clinical test ER 80%) Tj ET\nendstream']
 let pdf='%PDF-1.4\n';const offsets=[0]
 for(const [i,object] of objects.entries()){offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${object}\nendobj\n`}
 const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n `).join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
 const rendered=await imagePage(Buffer.from(pdf),'application/pdf',1);assert.equal(rendered.pages,1);assert.ok(rendered.buffer.length>1000)
})
test('DB semantic retrieval spans six modules; module routing, cache integrity and actual-supply provenance are enforced',async()=>{
 const previousPolicy=process.env.EXPERT_KNOWLEDGE_REQUIRE_CONFIRMATION,previousFetch=globalThis.fetch
 const source=(await pool.query('SELECT * FROM expert_knowledge LIMIT 1')).rows[0]
 const ids:string[]=[],modules=['cost','treatment','risk','hospitals','next','advanced']
 const profile='乳腺癌术后复查，正在咨询医疗费用与医院正式报价。'
 const requests:any[]=[]
 try{
  process.env.EXPERT_KNOWLEDGE_REQUIRE_CONFIRMATION='false'
  for(const module of modules){
   const id=randomUUID();ids.push(id)
   await pool.query(`INSERT INTO expert_knowledge(id,review_id,note_id,case_version_id,status,title,disease_key,module_key,guidance,evidence,applicability,exclusions,keywords,required_terms,excluded_terms) VALUES($1,$2,$3,$4,'expert_published','乳腺癌术后费用报价复核','breast_cancer',$5,'乳腺癌术后费用应按医院正式报价复核，不以历史病例承诺费用。','合成QA依据','乳腺癌术后复查，咨询医疗费用和报价。','未确诊乳腺病变','["费用","报价","乳腺癌"]','["术后"]','["未确诊"]')`,[id,source.review_id,randomUUID(),source.case_version_id,module])
  }
  globalThis.fetch=async(_url,init)=>{
   const body=JSON.parse(String(init?.body)),verification=applicabilityResponse(body)
   if(verification)return verification
   requests.push(body)
   return new Response(JSON.stringify({choices:[{message:{content:'{"synthetic":true}'}}]}),{headers:{'content-type':'application/json'}})
  }
  const matched=await retrieveExpertKnowledge('breast_cancer',profile)
  assert.deepEqual(matched.map(k=>k.module).sort(),[...modules].sort())
  let cache=await pool.query('SELECT * FROM expert_knowledge_vectors WHERE knowledge_id=ANY($1::uuid[])',[ids]);assert.equal(cache.rows.length,6)
  await pool.query(`UPDATE expert_knowledge_vectors SET embedding='[0]'::jsonb WHERE knowledge_id=$1`,[ids[0]])
  await pool.query('UPDATE expert_knowledge SET version=2 WHERE id=$1',[ids[1]])
  await retrieveExpertKnowledge('breast_cancer',profile)
  cache=await pool.query('SELECT * FROM expert_knowledge_vectors WHERE knowledge_id=ANY($1::uuid[])',[ids]);assert.equal(cache.rows.length,7)
  assert.equal(cache.rows.find(v=>v.knowledge_id===ids[0]).embedding.length,384)
  assert.ok(cache.rows.some(v=>v.knowledge_id===ids[1]&&v.knowledge_version===2))
  await withExpertKnowledge('professional','qa-module-routing','breast_cancer',profile,async()=>{
   for(const requested of [['cost'],['hospitals'],[]])await requestMedicalChatCompletion({messages:[{role:'system',content:'QA only'}],expertKnowledgeModules:requested,temperature:0})
  })
  assert.equal(requests.length,3)
  const references=(body:any)=>body.messages.flatMap((m:any)=>{try{return JSON.parse(m.content).expertReviewedReferences||[]}catch{return []}})
  assert.deepEqual(references(requests[0]).map((k:any)=>k.module),['cost'])
  assert.deepEqual(references(requests[1]).map((k:any)=>k.module),['hospitals'])
  assert.equal(references(requests[2]).length,0)
  const trace=(await pool.query("SELECT * FROM expert_generation_knowledge WHERE submission_no='qa-module-routing'")).rows[0]
  assert.equal(trace.retrieval.outcome,'matched');assert.equal(trace.retrieval.eligibleCount,6)
  assert.deepEqual(trace.citations.map((k:any)=>k.module).sort(),['cost','hospitals'])
  assert.ok(trace.citations.every((k:any)=>k.match.applicability.evidenceQuotes.length))
  globalThis.fetch=async()=>{throw Error('QA model outage')}
  await withExpertKnowledge('free','qa-verifier-failure','breast_cancer',profile,async()=>assert.equal(appendExpertKnowledge([{role:'system',content:'baseline'}]).length,1))
  const failed=(await pool.query("SELECT * FROM expert_generation_knowledge WHERE submission_no='qa-verifier-failure'")).rows[0]
  assert.deepEqual(failed.citations,[]);assert.equal(failed.retrieval.outcome,'applicability_unavailable')
  assert.ok(failed.retrieval.rejected.every((r:any)=>r.reason==='applicability_verifier_unavailable'))
 }finally{
  globalThis.fetch=previousFetch;process.env.EXPERT_KNOWLEDGE_REQUIRE_CONFIRMATION=previousPolicy
  await pool.query('DELETE FROM expert_knowledge_vectors WHERE knowledge_id=ANY($1::uuid[])',[ids])
  await pool.query('DELETE FROM expert_knowledge WHERE id=ANY($1::uuid[])',[ids])
 }
})
test('report/source drift creates a separate version and blocks submission of a stale review',async()=>{
 const d=(await call('GET',`/cases/free/${caseId}`,undefined,other)).json()
 const notes=d.case.modules.map((m:any)=>({id:randomUUID(),module:m.key,target:m.key,decision:'认可'}))
 const saved=await call('PUT',`/reviews/${d.review.id}`,{version:d.review.version,notes,confirmed:d.case.modules.map((m:any)=>m.key),drafts:{}},other)
 await pool.query("UPDATE report_submissions SET chief_complaint='新的医学事实，需重新核对。' WHERE id=$1",[caseId])
 const stale=await call('POST',`/reviews/${d.review.id}/submit`,{version:saved.json().review.version,attest:true},other);assert.equal(stale.statusCode,409);assert.equal(stale.json().error,'SOURCE_CHANGED')
})
test('logout invalidates the server-side session',async()=>{
 const out=await call('DELETE','/session',undefined,other);assert.equal(out.statusCode,200);const r=await call('GET','/session',undefined,other);assert.equal(r.statusCode,401)
})
