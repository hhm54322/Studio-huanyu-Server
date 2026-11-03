import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import type { FastifyRequest } from 'fastify'
import { pool } from '../db/pool.js'
import { ExpertError, type Session } from './schema.js'

const scrypt = promisify(scryptCallback)
export const tokenHash = (value:string) => createHash('sha256').update(value).digest('hex')
export const hashPassword = async (password:string) => {
 const salt=randomBytes(24).toString('hex'); const hash=await scrypt(password,salt,64) as Buffer
 return `scrypt:${salt}:${hash.toString('hex')}`
}
export const verifyPassword = async (password:string,stored:string) => {
 const [type,salt,hex]=stored.split(':'); if(type!=='scrypt'||!salt||!hex) return false
 const calculated=await scrypt(password,salt,64) as Buffer; const expected=Buffer.from(hex,'hex')
 return expected.length===calculated.length && timingSafeEqual(calculated,expected)
}
export const cookieName = process.env.NODE_ENV==='production'?'__Host-huanyu_expert':'huanyu_expert'
export const cookieValue = (token:string,maxAge=43200) => `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${process.env.NODE_ENV==='production'?'; Secure':''}`
export const sessionToken = (request:FastifyRequest) => String(request.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith(`${cookieName}=`))?.slice(cookieName.length+1)||''
export async function getSession(request:FastifyRequest):Promise<Session> {
 const token=sessionToken(request); if(!/^[a-f0-9]{64}$/.test(token)) throw new ExpertError(401,'UNAUTHENTICATED','请登录专家账号。')
 const hash=tokenHash(token)
 const result=await pool.query(`SELECT a.*,s.csrf_token FROM expert_sessions s JOIN expert_accounts a ON a.id=s.account_id WHERE s.token_hash=$1 AND s.expires_at>now() AND a.active=true`,[hash])
 const a=result.rows[0]; if(!a)throw new ExpertError(401,'UNAUTHENTICATED','登录已过期，请重新登录。')
 return {id:a.id,username:a.username,displayName:a.display_name,role:a.role,testAccount:a.test_account,csrf:a.csrf_token,tokenHash:hash}
}
export function requireOrigin(request:FastifyRequest) {
 const allowed=(process.env.EXPERT_ALLOWED_ORIGINS||'http://127.0.0.1:5190,http://localhost:5190,https://www.huanyumedical.com,https://huanyumedical.com').split(',').map(v=>v.trim())
 if(!request.headers.origin||!allowed.includes(request.headers.origin))throw new ExpertError(403,'INVALID_ORIGIN','请求来源不允许。')
}
export function requireCsrf(request:FastifyRequest,session:Session) {
 requireOrigin(request)
 const received=String(request.headers['x-expert-csrf']||''); const a=Buffer.from(received),b=Buffer.from(session.csrf)
 if(a.length!==b.length||!timingSafeEqual(a,b))throw new ExpertError(403,'CSRF_FAILED','安全校验失败，请刷新后重试。')
}
export function requireRole(session:Session,roles:string[]) {
 if(!roles.includes(session.role))throw new ExpertError(403,'FORBIDDEN','此账号没有该操作权限。')
}
export const audit = async (actor:string|null,action:string,id='',metadata:Record<string,unknown>={}) => pool.query('INSERT INTO expert_audit(actor_id,action,resource_id,metadata) VALUES($1,$2,$3,$4::jsonb)',[actor,action,id,JSON.stringify(metadata)])

const failures=new Map<string,{count:number;until:number}>()
export function checkLoginRate(ip:string,username:string) {
 const now=Date.now(); for(const [key,value] of failures)if(value.until<now)failures.delete(key)
 for(const key of [tokenHash(ip),tokenHash(`${ip}:${username.toLowerCase()}`)]) {
  const item=failures.get(key);if(item&&item.count>=10&&item.until>now)throw new ExpertError(429,'LOGIN_LIMIT','尝试过于频繁，请15分钟后重试。')
 }
 if(failures.size>10000)throw new ExpertError(429,'LOGIN_LIMIT','尝试过于频繁，请稍后重试。')
}
export function failedLogin(ip:string,username:string) {
 for(const key of [tokenHash(ip),tokenHash(`${ip}:${username.toLowerCase()}`)]) {
  const item=failures.get(key); failures.set(key,{count:(item?.count||0)+1,until:item?.until||Date.now()+900000})
 }
}
