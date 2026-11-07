import test from 'node:test';import assert from 'node:assert/strict';
import {assertDiscountAccess} from '../utils/discountAccess.js';
import {STAFF_ROLE_CODES} from '../utils/staffRoleProfiles.js';
test('discount decisions use grants for every built-in profile and its copies',()=>{
 for(const code of Object.values(STAFF_ROLE_CODES))for(const role of [{code},{code:'copy',profile:code}]){
 const context={owner:false,enforced:true,userId:'staff',roles:[role],grants:[]};
 assert.throws(()=>assertDiscountAccess(context,25),{status:403});
 context.grants=[{permission:'fees.discount.fee',scope:'all',maxAmount:50}];
 assert.doesNotThrow(()=>assertDiscountAccess(context,25));assert.throws(()=>assertDiscountAccess(context,51),{status:403});
 context.grants=[];assert.throws(()=>assertDiscountAccess(context,25),{status:403});
 }
});
test('inline discounts honor selected scope and validate amounts',()=>{
 const context={userId:'u',grants:[{permission:'fees.discount.fee',scope:'selected',batchIds:['allowed'],courseIds:[],maxAmount:50}]};
 assert.doesNotThrow(()=>assertDiscountAccess(context,25,{batchId:'allowed'}));
 assert.throws(()=>assertDiscountAccess(context,25,{batchId:'other'}),{status:403});
 assert.throws(()=>assertDiscountAccess(context,'invalid',{batchId:'allowed'}),{status:400});
 assert.throws(()=>assertDiscountAccess(context,-1,{batchId:'allowed'}),{status:400});
 assert.doesNotThrow(()=>assertDiscountAccess({grants:[]},0));
});
