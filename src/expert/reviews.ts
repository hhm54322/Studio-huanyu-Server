import type { PoolClient } from 'pg'
import { pool } from '../db/pool.js'
import { getCaseVersion, identityTerms, redactValue, sourceRow } from './cases.js'
import { ExpertError, type Mode, type ReviewModule, type ReviewNote, reviewPayloadSchema } from './schema.js'
import { attachmentSource } from './attachments.js'
import { requiresKnowledgeConfirmation } from './policy.js'
import { canonicalDisease } from './matching.js'

export async function getReview(versionId:string,expertId:string) {
 const result=await pool.query(`INSERT INTO expert_reviews(case_version_id,expert_id) VALUES($1,$2) ON CONFLICT(case_version_id,expert_id) DO UPDATE SET expert_id=EXCLUDED.expert_id RETURNING *`,[versionId,expertId])
 return result.rows[0]
}
export async function transaction<T>(run:(db:PoolClient)=>Promise<T>):Promise<T> {
 const db=await pool.connect();try{await db.query('BEGIN');const result=await run(db);await db.query('COMMIT');return result}catch(e){await db.query('ROLLBACK');throw e}finally{db.release()}
}
export function validateReview(notes:ReviewNote[],confirmed:string[],modules:ReviewModule[],fileCount:number) {
 if(new Set(notes.map(n=>n.id)).size!==notes.length)throw new ExpertError(400,'DUPLICATE_NOTE','记录编号重复。')
 const known=new Set(modules.map(m=>m.key))
 if(confirmed.some(k=>!known.has(k))||new Set(confirmed).size!==confirmed.length)throw new ExpertError(400,'INVALID_MODULE','模块确认记录无效。')
 for(const n of notes) {
  const module=modules.find(m=>m.key===n.module)
  if(!module?.targets.some(t=>t.id===n.target))throw new ExpertError(400,'INVALID_TARGET','批改位置不属于当前报告。')
  if(n.decision!=='认可'&&!n.text.trim())throw new ExpertError(400,'REASON_REQUIRED','请说明批改原因。')
  if(['修改','补充'].includes(n.decision)&&!n.replacement.trim())throw new ExpertError(400,'REPLACEMENT_REQUIRED','请填写建议文案。')
  if(n.evidenceFiles.some(i=>i>=fileCount))throw new ExpertError(400,'INVALID_FILE','引用资料不存在。')
  if(n.knowledge.candidate){
   if(!['修改','补充'].includes(n.decision)||!n.replacement.trim()||!n.evidence.trim()||!n.knowledge.title.trim()||!n.knowledge.applicability.trim()||!n.knowledge.exclusions.trim())throw new ExpertError(400,'KNOWLEDGE_INCOMPLETE','知识候选需要修改/补充建议、医学依据、标题、适用及不适用条件。')
   if(['overview','sample','packages','upgrade','fallback-8','fallback-13','fallback-14'].includes(n.module))throw new ExpertError(400,'KNOWLEDGE_NOT_MEDICAL','此模块不能作为医学知识候选。')
  }
 }
 for(const key of confirmed)if(!notes.some(n=>n.module===key))throw new ExpertError(400,'CONFIRMATION_WITHOUT_REVIEW','确认模块前需保存审阅记录。')
}
async function lockReview(db:PoolClient,id:string,expertId:string) {
 const r=await db.query(`SELECT r.*,v.mode,v.source_id,v.submission_no,v.fingerprint,v.modules,v.input FROM expert_reviews r JOIN expert_case_versions v ON v.id=r.case_version_id WHERE r.id=$1 AND r.expert_id=$2 FOR UPDATE OF r`,[id,expertId])
 if(!r.rows[0])throw new ExpertError(404,'REVIEW_NOT_FOUND','审阅不存在或不属于此账号。')
 return r.rows[0]
}
export async function saveReview(id:string,expertId:string,payload:ReturnType<typeof reviewPayloadSchema.parse>) {
 return transaction(async db=>{
  const review=await lockReview(db,id,expertId)
  if(review.status!=='draft')throw new ExpertError(409,'REVIEW_LOCKED','已提交的审阅不能修改。')
  if(review.version!==payload.version)throw new ExpertError(409,'VERSION_CONFLICT','其他窗口已更新此审阅。请重新载入，未保存内容请先复制。')
  const source=await sourceRow(review.mode,review.source_id),terms=identityTerms(source)
  const notes=redactValue(payload.notes,terms) as ReviewNote[]
  validateReview(notes,payload.confirmed,review.modules,review.input.uploads.length)
  const validKeys=new Set(review.modules.map((m:ReviewModule)=>m.key))
  if(Object.keys(payload.drafts).some(k=>!validKeys.has(k)))throw new ExpertError(400,'INVALID_MODULE','草稿模块无效。')
  const r=await db.query(`UPDATE expert_reviews SET notes=$2::jsonb,confirmed=$3::jsonb,drafts=$4::jsonb,version=version+1,updated_at=now() WHERE id=$1 RETURNING *`,[id,JSON.stringify(notes),JSON.stringify(payload.confirmed),JSON.stringify(redactValue(payload.drafts,terms))])
  await db.query(`INSERT INTO expert_audit(actor_id,action,resource_id,metadata) VALUES($1,'review_saved',$2,$3::jsonb)`,[expertId,id,JSON.stringify({version:r.rows[0].version,noteCount:notes.length})])
  return r.rows[0]
 })
}
export async function submitReview(id:string,expertId:string,version:number) {
 return transaction(async db=>{
  const review=await lockReview(db,id,expertId)
  // Retry after a lost response does not create duplicate candidates.
  if(review.status==='submitted')return review
  if(review.version!==version)throw new ExpertError(409,'VERSION_CONFLICT','审阅版本已更新，请重新载入。')
  const current=await getCaseVersion(review.mode as Mode,review.source_id)
  if(current.version.fingerprint!==review.fingerprint)throw new ExpertError(409,'SOURCE_CHANGED','原始报告或资料已变化，请审阅最新版本。')
  validateReview(review.notes,review.confirmed,review.modules,review.input.uploads.length)
  const missing=review.modules.filter((m:ReviewModule)=>!review.confirmed.includes(m.key)).map((m:ReviewModule)=>m.label)
  if(missing.length)throw new ExpertError(400,'INCOMPLETE_REVIEW',`尚未确认：${missing.join('、')}`)
  if(review.input.uploads.length){
   const previews=await db.query(`SELECT file_index,status,pages FROM expert_attachment_previews WHERE case_version_id=$1`,[review.case_version_id])
   for(const file of review.input.uploads){
    const verifiedSource=await attachmentSource(review.case_version_id,file.index)
    if(verifiedSource.preview.status!=='approved')throw new ExpertError(409,'REDACTION_PENDING',`资料 ${file.index+1} 需要重新确认脱敏。`)
    const p=previews.rows.find(p=>p.file_index===file.index)
    if(p?.status!=='approved')throw new ExpertError(409,'REDACTION_PENDING',`资料 ${file.index+1} 的原件尚未脱敏确认，不能提交完整审阅。`)
    const views=await db.query(`SELECT DISTINCT (metadata->>'page')::integer page FROM expert_audit WHERE actor_id=$1 AND resource_id=$2 AND action='redacted_attachment_viewed' AND (metadata->>'fileIndex')::integer=$3 AND created_at >= (SELECT confirmed_at FROM expert_attachment_previews WHERE case_version_id=$2 AND file_index=$3)`,[expertId,review.case_version_id,file.index])
    if(p.pages.images.some((image:any)=>!views.rows.some(v=>v.page===image.page)))throw new ExpertError(400,'ATTACHMENT_NOT_REVIEWED',`请先查看资料 ${file.index+1} 的全部脱敏原件，再提交。`)
   }
  }
  if(Object.values(review.drafts).some((d:any)=>d.text?.trim()||d.replacement?.trim()||d.evidence?.trim()))throw new ExpertError(400,'UNSAVED_DRAFT','还有未保存的批改内容。')
  for(const n of review.notes as ReviewNote[])if(n.knowledge.candidate){
   const status=requiresKnowledgeConfirmation()?'pending_confirmation':'expert_published'
   const inserted=await db.query(`INSERT INTO expert_knowledge(review_id,note_id,case_version_id,title,disease_key,module_key,guidance,evidence,applicability,exclusions,keywords,required_terms,excluded_terms,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14) ON CONFLICT(review_id,note_id) DO NOTHING RETURNING id`,[id,n.id,review.case_version_id,n.knowledge.title,canonicalDisease(current.source.visit_purpose),n.module,n.replacement,n.evidence,n.knowledge.applicability,n.knowledge.exclusions,JSON.stringify(n.knowledge.keywords),JSON.stringify(n.knowledge.requiredTerms),JSON.stringify(n.knowledge.excludedTerms),status])
   if(inserted.rows[0])await db.query(`INSERT INTO expert_audit(actor_id,action,resource_id,metadata) VALUES($1,'knowledge_created',$2,$3::jsonb)`,[expertId,inserted.rows[0].id,JSON.stringify({status,reviewId:id})])
  }
  const r=await db.query(`UPDATE expert_reviews SET status='submitted',submitted_at=now(),updated_at=now(),version=version+1 WHERE id=$1 RETURNING *`,[id])
  await db.query(`INSERT INTO expert_audit(actor_id,action,resource_id) VALUES($1,'review_submitted',$2)`,[expertId,id])
  return r.rows[0]
 })
}
