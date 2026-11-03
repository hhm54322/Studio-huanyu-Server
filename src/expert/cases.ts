import { createHash } from 'node:crypto'
import { pool } from '../db/pool.js'
import { ExpertError, type Mode, type ReviewModule } from './schema.js'
import { getReportSubmission } from '../db/reportSubmissions.js'
import { getProfessionalReportSubmission } from '../db/professionalReportSubmissions.js'
import { diseases } from '../report/knowledgeBase.js'

export const digest = (value:unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export async function sourceRow(mode:Mode,id:string) {
 const row=mode==='free'?await getReportSubmission(id):await getProfessionalReportSubmission(id)
 if(!row||row.report_status!=='generated'||!row.report_result)throw new ExpertError(404,'CASE_NOT_FOUND','病例不存在或报告尚未生成。')
 return row as unknown as Record<string,any>
}
const privateKeys=new Set(['fullName','full_name','dateOfBirth','date_of_birth','phone','email','idNumber','id_number','patient','address','patientName','doctorName','patientId','accessionNumber'])
const hiddenKeys=new Set(['relativePath','storedName','absolutePath','sourceDirectory','logId','resultShape','user_agent','ip_hash'])
export function identityTerms(row:Record<string,any>) {
 const values=['full_name','email','phone','id_number'].map(k=>String(row[k]||'').trim()).filter(v=>v.length>=2)
 if(row.date_of_birth){const iso=new Date(row.date_of_birth).toISOString().slice(0,10);values.push(iso,iso.split('-').reverse().join('-'),iso.split('-').reverse().join('/'))}
 const ocr=JSON.stringify(row.parsed_files||[])
 for(const match of ocr.matchAll(/(?:患者姓名|姓名|病人姓名|Nama\s*(?:Pasien)?|Patient\s*Name|DOB|Date\s*of\s*Birth|出生日期|身份证号|证件号|住址|Address)\s*[:：]\s*([^\n\\";]{2,100})/gi))values.push(match[1].trim())
 return [...new Set(values)].sort((a,b)=>b.length-a.length)
}
export function redactValue(value:any,terms:string[],key=''):any {
 if(hiddenKeys.has(key))return undefined
 if(privateKeys.has(key))return value?'***':''
 if(Array.isArray(value))return value.map(v=>redactValue(v,terms))
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!hiddenKeys.has(k)).map(([k,v])=>[k,redactValue(v,terms,k)]))
 if(typeof value!=='string')return value
 for(const term of terms)value=value.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'gi'),'***')
 return value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'***')
  .replace(/\b[1-9]\d{5}(?:18|19|20)\d{11}[0-9Xx]\b/g,'***')
  .replace(/((?:姓名|Patient\s*Name|Nama\s*(?:Pasien)?|住址|Address|DOB|Date\s*of\s*Birth|出生日期|No\.?\s*(?:RM|KTP)|电话|Phone|Tel)\s*[:：]\s*)[^\n;]{2,100}/gi,'$1***')
}
const labelMap:Record<string,string>={
 locale:'提交语言',full_name:'姓名',gender:'性别',date_of_birth:'出生日期',nationality:'国籍',id_type:'证件类型',id_number:'证件号码',phone:'电话',email:'邮箱',city:'常住城市',preferred_language:'首选语言',visit_purpose:'就医目的 / 科室',care_need:'就医诉求',care_need_other:'其他诉求说明',expected_treatment_time:'期望治疗时间',chief_complaint:'主诉 / 症状详情',diagnosis:'已知诊断',stage:'分期 / 严重程度',pathology_summary:'自行填写的病理摘要',imaging_summary:'自行填写的影像摘要',genetic_summary:'基因检测摘要',treatment_history:'既往治疗经过',medication_history:'用药史',comorbidities:'合并疾病',allergy_history:'过敏史',budget_range:'预算要求',insurance_type:'保险情况',desired_city:'期望就诊城市',urgency:'紧急程度',selected_regions:'希望对比的地区',
}
const display:Record<string,string>={...Object.fromEntries(Object.entries(diseases).map(([key,d])=>[key,d.label])),female:'女',male:'男',other:'其他',routine:'常规',urgent:'紧急',priority:'优先',zh:'中文',second_opinion:'第二诊疗意见',north_america:'北美',europe:'欧洲',southeast_asia:'东南亚',japan_korea:'日本 / 韩国','within_1_month':'1个月内','1_to_3_months':'1–3个月','3_to_6_months':'3–6个月'}
export function inputView(row:Record<string,any>,terms:string[]) {
 const identity=['full_name','gender','date_of_birth','nationality','id_type','id_number','phone','email','city','preferred_language']
 const preferences=['budget_range','insurance_type','desired_city','urgency','selected_regions','locale']
 const field=(key:string)=>{const raw=row[key]??'';const masked=privateKeys.has(key)&&raw;const redacted=masked?'***':redactValue(raw,terms);const value=Array.isArray(redacted)?redacted.map(v=>display[v]||v).join('、'):display[redacted]||String(redacted);return {key,label:labelMap[key],value,status:!raw||Array.isArray(raw)&&!raw.length?'empty':masked?'redacted':'provided'}}
 return {
  sourceNote:'原始提交记录：来自正式数据库。空白表示未填写，不能解释为无病史。',
  sourceInfo:Object.fromEntries(Object.entries(labelMap).filter(([key])=>key in row).map(([key])=>[key.replace(/_([a-z])/g,(_,c:string)=>c.toUpperCase()),privateKeys.has(key)?row[key]?'***':'':redactValue(row[key],terms)])),
  groups:[{title:'基本信息',fields:identity.filter(k=>k in row).map(field)},{title:'病情与病史（填写原文）',fields:Object.keys(labelMap).filter(k=>k in row&&!identity.includes(k)&&!preferences.includes(k)).map(field)},{title:'就医偏好与提交设置',fields:preferences.filter(k=>k in row).map(field)}],
  uploads:(row.uploaded_files||[]).map((f:any,index:number)=>{
   const parsed=(row.parsed_files||[]).find((p:any)=>p.originalName===f.originalName)||{}
   const facts=parsed.metadata?.medicalFacts||{}
   return redactValue({index,name:`资料 ${index+1}${String(f.originalName||'').match(/\.[a-z0-9]{1,8}$/i)?.[0]||''}`,mimeType:f.mimeType,size:f.size,status:parsed.status||'unparsed',parser:parsed.parser||'',summary:parsed.summary||'',text:parsed.text||'',reportType:facts.reportType||'',dates:(facts.dates||[]).filter((date:string)=>!terms.includes(date)),diagnoses:facts.diagnoses||[],indicators:facts.indicators||[],findings:facts.findings||[],metastasisSignals:facts.metastasisSignals||[]},terms)
  }),
 }
}
export function reportModules(mode:Mode,report:any):ReviewModule[] {
 const section=(key:string,label:string,original:unknown,targets:ReviewModule['targets']=[])=>({key,label,targets:[{id:key,label,original},...targets]})
 const blocks=(s:any)=> (s.blocks||[]).map((b:any,i:number)=>({id:`${s.key}-block-${i}`,label:b.title||`内容块 ${i+1}`,original:b}))
 if(mode==='professional')return [section('overview','报告概览 / 资料摘要',{patientSnapshot:report.patientSnapshot,executiveSummary:report.executiveSummary},[{id:'summary',label:'摘要',original:report.executiveSummary}]),...(report.tabs||[]).map((s:any)=>section(s.key,s.label,s,blocks(s)))]
 if(!(report.layoutSections||[]).length)return [section('overview','报告概览',{id:report.id,date:report.date,need:report.need}),section('fallback-8','患者摘要',{disease:report.disease,need:report.need}),section('fallback-9','国家对比',report.countries),section('fallback-10','来华就医评分',{score:report.score,advantages:report.advantages,concerns:report.concerns}),section('fallback-11','推荐医院',report.hospitals),section('fallback-12','就医方案',report.plan),section('fallback-13','专业报告示例入口',{type:'service'}),section('fallback-14','评估服务包',report.packages)]
 return [section('overview','报告概览',{id:report.id,date:report.date,need:report.need}),section('cost','治疗方案预估总费用',report.plan),section('hospitals','推荐医院',report.hospitals,(report.hospitals||[]).slice(0,3).map((h:any,i:number)=>({id:`hospital-${i}-${h.name}`,label:h.name,original:h}))),section('costDetails','治疗路径与费用拆分',report.plan.costBreakdown||report.plan),...(report.advancedCare?[section('advanced','前沿疗法与新药可及性',report.advancedCare)]:[]),...(report.layoutSections||[]).filter((s:any)=>!['cost','hospitals','hospitalDetails','records','upgrade'].includes(s.key)).map((s:any)=>section(s.key,s.label,s,blocks(s))),section('sample','专业版示例入口',{type:'service'}),section('packages','专业评估服务包',report.packages,(report.packages||[]).map((p:any,i:number)=>({id:`package-${i}`,label:p.name,original:p}))),section('upgrade','专业评估入口',{type:'service'})]
}
export async function getCaseVersion(mode:Mode,id:string) {
 const row=await sourceRow(mode,id),terms=identityTerms(row)
 const fingerprint=digest({report:row.report_result,raw:Object.fromEntries(Object.keys(labelMap).map(k=>[k,row[k]])),uploads:row.uploaded_files,parsed:row.parsed_files})
 const report=redactValue(row.report_result,terms),input=inputView(row,terms)
 // Do not retain the original filename in any expert-facing report field.
 for(const [i,f] of (row.uploaded_files||[]).entries()){
  const name=String(f.originalName||'');if(name){const replace=(v:any):any=>typeof v==='string'?v.split(name).join(input.uploads[i].name):Array.isArray(v)?v.map(replace):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,replace(x)])):v;Object.assign(report,replace(report))}
 }
 const modules=reportModules(mode,report)
 if(!modules.length||mode==='professional'&&modules.length<2)throw new ExpertError(409,'LEGACY_REPORT','该历史报告格式不支持当前审阅，请联系管理员。')
 const result=await pool.query(`INSERT INTO expert_case_versions(mode,source_id,submission_no,fingerprint,report,input,modules) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb) ON CONFLICT(mode,source_id,fingerprint) DO UPDATE SET fingerprint=EXCLUDED.fingerprint RETURNING *`,[mode,row.id,row.submission_no,fingerprint,JSON.stringify(report),JSON.stringify(input),JSON.stringify(modules)])
 return {version:result.rows[0],source:row}
}
export async function listCases(expertId:string,page:number,search:string) {
 const limit=20,offset=(page-1)*limit,filter=search.trim().slice(0,80)
 const result=await pool.query(`WITH cases AS (
 SELECT id,submission_no,'free'::text mode,visit_purpose,gender,nationality,created_at,report_status,uploaded_files FROM report_submissions WHERE report_status='generated'
 UNION ALL SELECT id,submission_no,'professional',visit_purpose,gender,nationality,created_at,report_status,uploaded_files FROM professional_report_submissions WHERE report_status='generated'
 ) SELECT c.*,count(*) OVER() total,
 (SELECT r.status FROM expert_reviews r JOIN expert_case_versions v ON v.id=r.case_version_id WHERE v.mode=c.mode AND v.source_id=c.id AND r.expert_id=$1 ORDER BY v.created_at DESC LIMIT 1) review_status
 FROM cases c WHERE ($2='' OR c.submission_no ILIKE '%'||$2||'%' OR c.visit_purpose ILIKE '%'||$2||'%') ORDER BY c.created_at DESC,c.id LIMIT $3 OFFSET $4`,[expertId,filter,limit,offset])
 return {items:result.rows.map(r=>({id:r.id,submissionNo:r.submission_no,mode:r.mode,visitPurpose:r.visit_purpose,gender:r.gender,nationality:r.nationality,createdAt:r.created_at,uploadCount:r.uploaded_files.length,reviewStatus:r.review_status||'unreviewed'})),total:Number(result.rows[0]?.total||0),page,limit}
}
