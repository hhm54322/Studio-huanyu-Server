import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { z } from 'zod'
import { pool } from '../db/pool.js'
import { config } from '../config.js'
import { sourceRow, identityTerms, redactValue } from './cases.js'
import { ExpertError } from './schema.js'
import { transaction } from './reviews.js'

const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex')
export type Rect={x:number;y:number;width:number;height:number}
export const previewPayload=z.object({
 revision:z.number().int().min(1),sourceHash:z.string().regex(/^[a-f0-9]{64}$/),attest:z.literal(true),
 pages:z.array(z.object({page:z.number().int().min(1).max(100),masks:z.array(z.object({x:z.number().min(0).max(1),y:z.number().min(0).max(1),width:z.number().positive().max(1),height:z.number().positive().max(1)})).max(100)})).min(1).max(100),
 redactedText:z.string().max(100000).default(''),
})
export async function attachmentSource(caseVersionId:string,index:number) {
 const result=await pool.query('SELECT * FROM expert_case_versions WHERE id=$1',[caseVersionId]);const v=result.rows[0]
 if(!v)throw new ExpertError(404,'NOT_FOUND','病例不存在。')
 const row=await sourceRow(v.mode,v.source_id),file=row.uploaded_files[index]
 if(!file)throw new ExpertError(404,'FILE_NOT_FOUND','资料不存在。')
 const root=await realpath(path.resolve(config.uploadDir))
 let target:string;try{target=await realpath(path.resolve(file.relativePath))}catch{throw new ExpertError(404,'SOURCE_FILE_MISSING','历史原件缺失，请重新提供资料。')}
 const relative=path.relative(root,target)
 if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw new ExpertError(403,'UNSAFE_FILE','资料存储路径不允许。')
 const buffer=await readFile(target);if(buffer.length>50*1024*1024)throw new ExpertError(413,'FILE_TOO_LARGE','文件过大。')
 const sourceHash=sha(buffer)
 const preview=await pool.query(`INSERT INTO expert_attachment_previews(case_version_id,file_index,source_hash) VALUES($1,$2,$3) ON CONFLICT(case_version_id,file_index) DO UPDATE SET source_hash=EXCLUDED.source_hash,status=CASE WHEN expert_attachment_previews.source_hash=EXCLUDED.source_hash THEN expert_attachment_previews.status ELSE 'pending_redaction' END,revision=CASE WHEN expert_attachment_previews.source_hash=EXCLUDED.source_hash THEN expert_attachment_previews.revision ELSE expert_attachment_previews.revision+1 END RETURNING *`,[caseVersionId,index,sourceHash])
 const p=preview.rows[0]
 return {row,file,buffer,sourceHash,preview:p}
}
export async function imagePage(buffer:Buffer,mime:string,page:number):Promise<{buffer:Buffer;pages:number}> {
 if(mime.startsWith('image/')){
  if(page!==1)throw new ExpertError(404,'PAGE_NOT_FOUND','页码不存在。')
  return {buffer:await sharp(buffer,{limitInputPixels:50000000}).rotate().jpeg({quality:92}).toBuffer(),pages:1}
 }
 if(mime==='application/pdf'){
  const {PDFParse}=await import('pdf-parse');const parser=new PDFParse({data:new Uint8Array(buffer)})
  try{
   const info=await parser.getInfo();if(info.total>100)throw new ExpertError(413,'TOO_MANY_PAGES','资料超过100页，请分文件处理。')
   if(page<1||page>info.total)throw new ExpertError(404,'PAGE_NOT_FOUND','页码不存在。')
   const screenshot=await parser.getScreenshot({partial:[page],desiredWidth:1800,imageBuffer:true,imageDataUrl:false})
   const b=screenshot.pages[0]?.data;if(!b)throw new ExpertError(422,'PREVIEW_FAILED','PDF页面无法渲染。')
   return {buffer:await sharp(Buffer.from(b)).jpeg({quality:92}).toBuffer(),pages:info.total}
  }finally{await parser.destroy()}
 }
 if(mime==='text/plain'){
  // Render the actual uploaded UTF text, not the parser's summary, so it can be
  // checked and irreversibly masked through the same per-page privacy workflow.
  let text:string
  try{
   const encoding=buffer[0]===0xff&&buffer[1]===0xfe?'utf-16le':buffer[0]===0xfe&&buffer[1]===0xff?'utf-16be':'utf-8'
   text=new TextDecoder(encoding,{fatal:true}).decode(buffer)
  }catch{throw new ExpertError(422,'TEXT_ENCODING_UNSUPPORTED','文本编码无法安全预览，请转为UTF-8文本或PDF。')}
  const lines=text.replace(/\r\n?/g,'\n').replace(/\t/g,'    ').split('\n').flatMap(line=>{
   const chars=Array.from(line),parts:string[]=[]
   for(let start=0;start<chars.length;start+=60)parts.push(chars.slice(start,start+60).join(''))
   return parts.length?parts:['']
  })
  const pages=Math.max(1,Math.ceil(lines.length/45))
  if(pages>100)throw new ExpertError(413,'TOO_MANY_PAGES','资料超过100页，请分文件处理。')
  if(page<1||page>pages)throw new ExpertError(404,'PAGE_NOT_FOUND','页码不存在。')
  const escape=(value:string)=>value.replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]!))
  const body=lines.slice((page-1)*45,page*45).map((line,index)=>`<text x="60" y="${80+index*32}">${escape(line)}</text>`).join('')
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="1560"><rect width="100%" height="100%" fill="white"/><g fill="black" font-family="Noto Sans CJK SC, sans-serif" font-size="24" xml:space="preserve">${body}</g></svg>`
  return {buffer:await sharp(Buffer.from(svg)).jpeg({quality:92}).toBuffer(),pages}
 }
 throw new ExpertError(422,'UNSUPPORTED_PREVIEW','此格式需转换为已脱敏的图片或PDF后才能预览；不会公开原件。')
}
export async function maskImage(buffer:Buffer,masks:Rect[]) {
 const meta=await sharp(buffer).metadata(),width=meta.width!,height=meta.height!
 const rects=masks.map(r=>{
  if(r.x+r.width>1.00001||r.y+r.height>1.00001)throw new ExpertError(400,'INVALID_MASK','遮盖范围超出页面。')
  return `<rect x="${Math.floor(r.x*width)}" y="${Math.floor(r.y*height)}" width="${Math.ceil(r.width*width)+1}" height="${Math.ceil(r.height*height)+1}" fill="#000"/>`
 }).join('')
 // Raster re-encoding: no hidden text layer, EXIF, original pixels or reversible mask.
 return sharp(buffer).composite([{input:Buffer.from(`<svg width="${width}" height="${height}">${rects}</svg>`)}]).jpeg({quality:90}).toBuffer()
}
export async function publishPreview(caseVersionId:string,index:number,actor:string,payload:z.infer<typeof previewPayload>) {
 const source=await attachmentSource(caseVersionId,index)
 if(source.preview.revision!==payload.revision||source.sourceHash!==payload.sourceHash)throw new ExpertError(409,'VERSION_CONFLICT','资料已变化，请重新检查脱敏。')
 const first=await imagePage(source.buffer,source.file.mimeType,1)
 const unique=new Set(payload.pages.map(p=>p.page))
 if(unique.size!==first.pages||payload.pages.length!==first.pages||payload.pages.some(p=>p.page>first.pages))throw new ExpertError(400,'INCOMPLETE_REDACTION','需逐页确认全部资料，不能跳过页面。')
 const viewed=await pool.query(`SELECT DISTINCT (metadata->>'page')::integer page FROM expert_audit WHERE actor_id=$1 AND resource_id=$2 AND action='sensitive_attachment_curation_viewed' AND (metadata->>'fileIndex')::integer=$3 AND metadata->>'sourceHash'=$4`,[actor,caseVersionId,index,source.sourceHash])
 if(payload.pages.some(p=>!viewed.rows.some(v=>v.page===p.page)))throw new ExpertError(400,'CURATION_NOT_VIEWED','请加载并逐页查看全部原件，再确认脱敏。')
 const privateRoot=path.resolve(config.uploadDir,'expert-previews',randomUUID());await mkdir(privateRoot,{recursive:true,mode:0o700})
 const pages:{page:number;path:string;hash:string;masks:Rect[]}[]=[]
 for(const item of [...payload.pages].sort((a,b)=>a.page-b.page)){
  const raw=item.page===1?first:await imagePage(source.buffer,source.file.mimeType,item.page)
  const masked=await maskImage(raw.buffer,item.masks);const file=path.join(privateRoot,`${item.page}.jpg`)
  await writeFile(file,masked,{mode:0o600});pages.push({page:item.page,path:file,hash:sha(masked),masks:item.masks})
 }
 const text=redactValue(payload.redactedText,identityTerms(source.row))
 return transaction(async db=>{
  const r=await db.query(`UPDATE expert_attachment_previews SET status='approved',pages=$4::jsonb,confirmed_by=$5,confirmed_at=now(),revision=revision+1,updated_at=now() WHERE case_version_id=$1 AND file_index=$2 AND revision=$3 AND source_hash=$6 RETURNING id,revision,status`,[caseVersionId,index,payload.revision,JSON.stringify({images:pages,text}),actor,source.sourceHash])
  if(!r.rows[0])throw new ExpertError(409,'VERSION_CONFLICT','其他窗口已更新资料脱敏，请刷新。')
  await db.query(`INSERT INTO expert_audit(actor_id,action,resource_id,metadata) VALUES($1,'attachment_redaction_confirmed',$2,$3::jsonb)`,[actor,r.rows[0].id,JSON.stringify({sourceHash:source.sourceHash,pageCount:pages.length})])
  return r.rows[0]
 })
}
export async function approvedPage(caseVersionId:string,index:number,page:number) {
 const source=await attachmentSource(caseVersionId,index)
 if(source.preview.status!=='approved')throw new ExpertError(409,'REDACTION_PENDING','资料尚未完成脱敏确认，暂不能展示原件。')
 const item=source.preview.pages?.images?.find((p:any)=>p.page===page)
 if(!item)throw new ExpertError(404,'PAGE_NOT_FOUND','页码不存在。')
 const root=await realpath(path.resolve(config.uploadDir,'expert-previews')),target=await realpath(item.path)
 if(path.relative(root,target).startsWith('..'))throw new ExpertError(403,'UNSAFE_FILE','预览路径不允许。')
 const buffer=await readFile(target);if(sha(buffer)!==item.hash)throw new ExpertError(409,'PREVIEW_CHANGED','预览校验失败，请重新脱敏。')
 return buffer
}
