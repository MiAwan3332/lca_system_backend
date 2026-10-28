import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import Role from '../models/roles.js';
import User from '../models/users.js';
import Assignment from '../models/accessAssignment.js';
import Audit from '../models/accessAudit.js';
import {staffRoleProfiles,STAFF_ROLE_CODES} from '../utils/staffRoleProfiles.js';
const apply=process.argv.includes('--apply');
const backup=process.argv.find(v=>v.startsWith('--backup='))?.slice(9);
if(apply&&!backup)throw new Error('Supply an absolute backup path before applying');
await mongoose.connect(process.env.MONGO_URI,{autoIndex:false,autoCreate:false});
try{
 const owner=await User.findOne({_id:'6a4d7603f9f83920a371e5c2',platformOwner:true}).lean();
 if(!owner)throw new Error('Protected owner precondition failed');
 const requested=[{email:'atifhussainhussain1100@gmail.com',code:STAFF_ROLE_CODES.accounts},{email:'miawanofficial@gmail.com',code:STAFF_ROLE_CODES.vice}];
 const users=await User.find({email:{$in:requested.map(t=>t.email)}}).lean();
 if(users.length!==requested.length||users.some(u=>u.platformOwner||u.disabledAt||u.accountType!=='staff'||!u.accessManaged))throw new Error('Target account preconditions failed');
 const ids=users.map(u=>u._id), profiles=staffRoleProfiles();
 const existing=await Role.find({code:{$in:profiles.map(p=>p.code)}}).lean();
 const normalized=g=>JSON.stringify(g.map(({permission,scope,fields=[]})=>({permission,scope,fields})).sort((a,b)=>(a.permission+a.scope).localeCompare(b.permission+b.scope)));
 for(const r of existing){const p=profiles.find(p=>p.code===r.code);if(!r.active||normalized(r.grants)!==normalized(p.grants))throw new Error('Existing canonical role differs: '+r.code);}
 const old=await Assignment.find({user:{$in:ids},revokedAt:null}).lean();
 const snapshot={createdAt:new Date().toISOString(),roles:existing,assignments:old,users:users.map(({_id,name,email,role,accessManaged,platformOwner,disabledAt})=>({_id,name,email,role,accessManaged,platformOwner,disabledAt}))};
 const fingerprint=crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
 const plan={apply,roles:profiles.map(p=>({name:p.name,code:p.code,grants:p.grants.length})),targets:requested.map(t=>({email:t.email,role:profiles.find(p=>p.code===t.code).name})),ownerApprovals:true,otherUsersChanged:0,fingerprint};
 if(!apply){console.log(JSON.stringify(plan));}else{
  await fs.writeFile(backup,JSON.stringify(snapshot,null,2),{flag:'wx',mode:0o600});
  const createdRoles=[],createdAssignments=[],revoked=[];
  try{
   const policies=new Map(existing.map(r=>[r.code,r]));
   for(const p of profiles)if(!policies.has(p.code)){const r=await Role.create({...p,active:true,managed:true,revision:1});createdRoles.push(r._id);policies.set(p.code,r);}
   for(const target of requested){
    const u=users.find(u=>u.email===target.email), policy=policies.get(target.code);
    const previous=old.filter(a=>String(a.user)===String(u._id));
    if(previous.length===1&&String(previous[0].role)===String(policy._id)&&!previous[0].expiresAt)continue;
    for(const a of previous){const result=await Assignment.updateOne({_id:a._id,revokedAt:null},{$set:{revokedAt:new Date()}});if(result.modifiedCount!==1)throw new Error('Assignment changed concurrently');revoked.push(a._id);}
    const next=await Assignment.create({user:u._id,role:policy._id,assignedBy:owner._id});createdAssignments.push(next._id);
    await Audit.create({actor:owner._id,action:'staff-profile.assign',target:String(u._id),before:previous,after:{assignment:next.toObject(),profile:policy.code},reason:'User-approved system-wide business scope; owner retains refund/expense approvals. Backup: '+backup});
   }
   for(const id of createdRoles)await Audit.create({actor:owner._id,action:'staff-profile.create',target:String(id),after:await Role.findById(id).lean(),reason:'User-approved four staff profiles; owner retains approvals'});
   console.log(JSON.stringify({...plan,createdRoles:createdRoles.length,assignedUsers:createdAssignments.length,revokedAssignments:revoked.length,backup}));
  }catch(error){
   await Assignment.deleteMany({_id:{$in:createdAssignments}});
   await Assignment.updateMany({_id:{$in:revoked}},{$unset:{revokedAt:1}});
   await Role.deleteMany({_id:{$in:createdRoles}});
   throw error;
  }
 }
}finally{await mongoose.disconnect();}
