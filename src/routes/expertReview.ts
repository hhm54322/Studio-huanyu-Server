import { randomBytes } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z, ZodError } from 'zod'
import { pool } from '../db/pool.js'
import { getCaseVersion, listCases, identityTerms, redactValue } from '../expert/cases.js'
import { getReview, saveReview, submitReview, transaction } from '../expert/reviews.js'
import { knowledgePolicy } from '../expert/policy.js'
import { loginSchema, modeSchema, reviewPayloadSchema, submitSchema, ExpertError } from '../expert/schema.js'
import { audit, checkLoginRate, cookieValue, failedLogin, getSession, hashPassword, requireCsrf, requireOrigin, requireRole, tokenHash, verifyPassword } from '../expert/security.js'
import { approvedPage, attachmentSource, imagePage, previewPayload, publishPreview } from '../expert/attachments.js'
import { matchingVersion } from '../expert/matching.js'
import { embedTexts, semanticModel } from '../expert/semantic.js'

export async function registerExpertReviewRoutes(parent:FastifyInstance) {
 if(process.env.EXPERT_REVIEW_ENABLED!=='true')return
 await parent.register(async app=>{
  app.addHook('onRequest',async (request,reply)=>{if(request.method==='OPTIONS')return reply.code(204).send()})
  app.addHook('onSend',async (_req,reply,payload)=>{reply.header('Cache-Control','private, no-store').header('Vary','Cookie').header('X-Robots-Tag','noindex, nofollow, nosnippet');return payload})
  app.setErrorHandler((error,_request,reply)=>{
   if(error instanceof ExpertError)return reply.code(error.status).send({success:false,error:error.code,message:error.message})
   if(error instanceof ZodError)return reply.code(400).send({success:false,error:'VALIDATION_ERROR',message:'请检查填写内容。',issues:error.issues.map(i=>({path:i.path.join('.'),message:i.message}))})
   app.log.error({code:(error as any).code},'Expert review request failed')
   return reply.code(500).send({success:false,error:'EXPERT_REQUEST_FAILED',message:'操作失败，请稍后重试。'})
  })
  const dummy=await hashPassword(randomBytes(24).toString('hex'))
  app.post('/session',async(req,reply)=>{
   requireOrigin(req);const input=loginSchema.parse(req.body);checkLoginRate(req.ip,input.username)
   const result=await pool.query('SELECT * FROM expert_accounts WHERE username=$1 AND active=true',[input.username])
   const a=result.rows[0],valid=await verifyPassword(input.password,a?.password_hash||dummy)
   if(!a||!valid){failedLogin(req.ip,input.username);await audit(null,'login_failed','',{ipHash:tokenHash(req.ip)});throw new ExpertError(401,'INVALID_CREDENTIALS','账号或密码不正确。')}
   const token=randomBytes(32).toString('hex'),csrf=randomBytes(32).toString('hex')
   await pool.query(`DELETE FROM expert_sessions WHERE expires_at<now()`)
   await pool.query(`INSERT INTO expert_sessions(token_hash,account_id,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval '12 hours')`,[tokenHash(token),a.id,csrf])
   await audit(a.id,'login');reply.header('Set-Cookie',cookieValue(token))
   return {success:true,user:{id:a.id,username:a.username,displayName:a.display_name,role:a.role,testAccount:a.test_account},csrf,knowledgePolicy:knowledgePolicy()}
  })
  app.get('/session',async req=>{const s=await getSession(req);return {success:true,user:{id:s.id,username:s.username,displayName:s.displayName,role:s.role,testAccount:s.testAccount},csrf:s.csrf,knowledgePolicy:knowledgePolicy()}})
  app.delete('/session',async(req,reply)=>{const s=await getSession(req);requireCsrf(req,s);await pool.query('DELETE FROM expert_sessions WHERE token_hash=$1',[s.tokenHash]);await audit(s.id,'logout');reply.header('Set-Cookie',cookieValue('',0));return {success:true}})
  app.get('/cases',async req=>{const s=await getSession(req);requireRole(s,['expert','admin','data_curator']);const q=z.object({page:z.coerce.number().int().min(1).max(10000).default(1),search:z.string().max(80).default('')}).parse(req.query);return {success:true,...await listCases(s.id,q.page,q.search)}})
  app.get('/cases/:mode/:id',async req=>{
   const s=await getSession(req);requireRole(s,['expert','admin','data_curator']);const {mode,id}=params(req)
   const {version:v}=await getCaseVersion(mode,id),review=s.role==='data_curator'?null:await getReview(v.id,s.id)
   const previews=await pool.query('SELECT file_index,status,pages,revision FROM expert_attachment_previews WHERE case_version_id=$1',[v.id])
   const input=structuredClone(v.input)
   for(const f of input.uploads){const p=previews.rows.find(p=>p.file_index===f.index);f.previewStatus=p?.status||'pending_redaction';f.pageCount=p?.status==='approved'?p.pages?.images?.length||0:0;f.text=p?.status==='approved'?p.pages?.text||'':''}
   const traces=await pool.query('SELECT citations,retrieval,status,created_at FROM expert_generation_knowledge WHERE submission_no=$1 ORDER BY created_at DESC LIMIT 1',[v.submission_no])
   await audit(s.id,'case_viewed',v.id)
   return {success:true,case:{id:v.id,sourceId:v.source_id,mode:v.mode,submissionNo:v.submission_no,fingerprint:v.fingerprint,report:v.report,input,modules:v.modules,createdAt:v.created_at},review,generationContext:traces.rows[0]||null}
  })
  app.put('/reviews/:id',async req=>{const s=await getSession(req);requireRole(s,['expert','admin']);requireCsrf(req,s);const id=z.string().uuid().parse((req.params as any).id);return {success:true,review:await saveReview(id,s.id,reviewPayloadSchema.parse(req.body))}})
  app.post('/reviews/:id/submit',async req=>{const s=await getSession(req);requireRole(s,['expert','admin']);requireCsrf(req,s);const id=z.string().uuid().parse((req.params as any).id),p=submitSchema.parse(req.body);return {success:true,review:await submitReview(id,s.id,p.version)}})
  app.get('/knowledge',async req=>{
   await getSession(req);const q=z.object({page:z.coerce.number().int().min(1).max(10000).default(1),status:z.enum(['all','pending_confirmation','expert_published','approved','rejected','withdrawn']).default('all')}).parse(req.query)
   const r=await pool.query(`SELECT k.*,a.display_name expert_name,a.id expert_id,v.submission_no,count(*) OVER() total FROM expert_knowledge k JOIN expert_reviews r ON r.id=k.review_id JOIN expert_accounts a ON a.id=r.expert_id JOIN expert_case_versions v ON v.id=k.case_version_id WHERE ($1='all' OR k.status=$1) ORDER BY k.created_at DESC LIMIT 30 OFFSET $2`,[q.status,(q.page-1)*30])
   return {success:true,items:r.rows,total:Number(r.rows[0]?.total||0),page:q.page,publicationEnabled:knowledgePolicy().directFeedbackEnabled,knowledgePolicy:knowledgePolicy()}
  })
  app.get('/knowledge/matching-status',async req=>{
   const s=await getSession(req);requireRole(s,['admin','expert'])
   try{const [vector]=await embedTexts(['医学资料与专家知识相关性检查'],'query');return {success:true,algorithm:matchingVersion,model:semanticModel,localSemanticReady:vector.length===384}}
   catch{return {success:true,algorithm:matchingVersion,model:semanticModel,localSemanticReady:false}}
  })
  app.post('/knowledge/:id/withdraw',async req=>{
   const s=await getSession(req);requireRole(s,['expert','admin']);requireCsrf(req,s);const id=z.string().uuid().parse((req.params as any).id)
   return transaction(async db=>{
    const selected=await db.query('SELECT k.*,r.expert_id FROM expert_knowledge k JOIN expert_reviews r ON r.id=k.review_id WHERE k.id=$1 FOR UPDATE OF k',[id]),k=selected.rows[0]
    if(!k||s.role!=='admin'&&k.expert_id!==s.id)throw new ExpertError(404,'NOT_FOUND','知识不存在或不属于此账号。')
    if(k.status!=='withdrawn'){
     await db.query("UPDATE expert_knowledge SET status='withdrawn' WHERE id=$1",[id])
     await db.query("INSERT INTO expert_audit(actor_id,action,resource_id,metadata) VALUES($1,'knowledge_withdrawn',$2,$3::jsonb)",[s.id,id,JSON.stringify({previousStatus:k.status})])
    }
    return {success:true}
   })
  })
  // Concept and schema are reserved. No mutation endpoint can approve knowledge in this phase.
  app.post('/knowledge/:id/approve',async req=>{const s=await getSession(req);requireCsrf(req,s);requireRole(s,['knowledge_confirmer']);throw new ExpertError(409,'CONFIRMATION_NOT_ENABLED','专人确认功能暂未启用，禁止发布。')})
  app.get('/cases/:version/files/:index/pages/:page',async(req,reply)=>{
   const s=await getSession(req);requireRole(s,['expert','admin','data_curator']);const p=fileParams(req)
   const buffer=await approvedPage(p.version,p.index,p.page);await audit(s.id,'redacted_attachment_viewed',p.version,{fileIndex:p.index,page:p.page})
   return reply.type('image/jpeg').header('Content-Disposition','inline; filename="medical-record.jpg"').send(buffer)
  })
  app.get('/curation/:version/files/:index',async req=>{
   const s=await getSession(req);requireRole(s,['admin','data_curator']);const p=fileParams(req,false),source=await attachmentSource(p.version,p.index)
   const image=await imagePage(source.buffer,source.file.mimeType,1),parsed=source.row.parsed_files.find((v:any)=>v.originalName===source.file.originalName)
   await audit(s.id,'attachment_curation_opened',p.version,{fileIndex:p.index})
   return {success:true,sourceHash:source.sourceHash,revision:source.preview.revision,pageCount:image.pages,suggestedText:redactValue(parsed?.text||'',identityTerms(source.row))}
  })
  app.get('/curation/:version/files/:index/pages/:page',async(req,reply)=>{
   const s=await getSession(req);requireRole(s,['admin','data_curator']);const p=fileParams(req),source=await attachmentSource(p.version,p.index)
   const image=await imagePage(source.buffer,source.file.mimeType,p.page);await audit(s.id,'sensitive_attachment_curation_viewed',p.version,{fileIndex:p.index,page:p.page,sourceHash:source.sourceHash})
   return reply.type('image/jpeg').header('Content-Disposition','inline; filename="curation-only.jpg"').send(image.buffer)
  })
  app.post('/curation/:version/files/:index',async req=>{const s=await getSession(req);requireRole(s,['admin','data_curator']);requireCsrf(req,s);const p=fileParams(req,false);return {success:true,...await publishPreview(p.version,p.index,s.id,previewPayload.parse(req.body))}})
 },{prefix:'/api/expert'})
}
function params(req:FastifyRequest){return z.object({mode:modeSchema,id:z.string().min(1).max(100)}).parse(req.params)}
function fileParams(req:FastifyRequest,withPage=true){return z.object({version:z.string().uuid(),index:z.coerce.number().int().min(0).max(19),page:z.coerce.number().int().min(1).max(100).default(1)}).parse({...req.params as any,...(!withPage?{page:1}:{})})}
