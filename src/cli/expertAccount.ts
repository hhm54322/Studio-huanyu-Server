import { pool, closePool } from '../db/pool.js'
import { migrateExpertReview } from '../expert/migration.js'
import { audit, hashPassword } from '../expert/security.js'

const [action,username,role='expert']=process.argv.slice(2)
try {
 if(!username||!['create','disable','password'].includes(action)||!['expert','admin','data_curator','knowledge_confirmer'].includes(role))throw Error('Usage: expertAccount create|password|disable USER [expert|admin|data_curator|knowledge_confirmer]; password from EXPERT_ACCOUNT_PASSWORD; --test-account permits test password.')
 await migrateExpertReview(pool)
 const existing=(await pool.query('SELECT id FROM expert_accounts WHERE username=$1',[username])).rows[0]
 if(action==='disable'){
  if(!existing)throw Error('Account not found')
  await pool.query('UPDATE expert_accounts SET active=false WHERE id=$1',[existing.id]);await pool.query('DELETE FROM expert_sessions WHERE account_id=$1',[existing.id]);await audit(existing.id,'account_disabled',existing.id)
 }else{
  const test=process.argv.includes('--test-account'),password=process.env.EXPERT_ACCOUNT_PASSWORD||''
  if(!password||(password.length<14&&!test))throw Error('Provide EXPERT_ACCOUNT_PASSWORD (minimum 14 characters outside test accounts).')
  if(role==='knowledge_confirmer')throw Error('Knowledge confirmer provisioning is reserved; confirmation is not enabled in this phase.')
  const hash=await hashPassword(password)
  if(action==='create'){
   if(existing)throw Error('Account exists; use password action explicitly.')
   const r=await pool.query('INSERT INTO expert_accounts(username,display_name,password_hash,role,test_account) VALUES($1,$2,$3,$4,$5) RETURNING id',[username,process.env.EXPERT_DISPLAY_NAME||username,hash,role,test]);await audit(r.rows[0].id,'account_created',r.rows[0].id,{role,testAccount:test})
  }else{
   if(!existing)throw Error('Account not found')
   await pool.query('UPDATE expert_accounts SET password_hash=$2,test_account=$3 WHERE id=$1',[existing.id,hash,test]);await pool.query('DELETE FROM expert_sessions WHERE account_id=$1',[existing.id]);await audit(existing.id,'account_password_changed',existing.id,{testAccount:test})
  }
 }
 console.log(`Expert account ${action} completed. No password printed.`)
}catch(error){console.error(error instanceof Error?error.message:'Account operation failed');process.exitCode=1}finally{await closePool()}
