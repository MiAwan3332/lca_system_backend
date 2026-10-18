import mongoose from 'mongoose';
import { fileURLToPath } from 'node:url';

const uri = process.env.CREATION_TEST_URI;
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\/lca_verify_[a-z0-9_]+$/.test(uri || '')) throw new Error('Isolated test URI required');
await mongoose.connect(uri);
const { commitCreation, processCreationOnce, claimCreation } = await import('../utils/creationService.js');
const { default: Request } = await import('../models/creationRequests.js');
const mode = process.argv[2];
try {
  if (mode === 'commit') {
    const request = await Request.findById(process.argv[3]).select('+plan');
    let writes = 0;
    await commitCreation(request, true, { afterWrite: async (name) => {
      writes++;
      if (writes === Number(process.argv[4])) {
        process.send({ boundary: name, writes });
        await new Promise(() => {}); // Parent forcibly terminates the process, not a caught exception.
      }
    } });
  } else if (mode === 'preflight') {
    const input = JSON.parse(process.argv[3]);
    const req = { user: { user: { id: input.actor } }, body: input.body,
      get: (name) => name === 'Idempotency-Key' ? input.key : name === 'X-Creation-Protocol' ? '2' : undefined };
    const res = { setHeader() {}, once() {}, status() { return this; }, json() { throw new Error('Preflight claim unexpectedly rejected'); } };
    await claimCreation('student')(req, res, (error) => { if (error) throw error; });
    let roll;
    if (Number(process.argv[4]) === 1) {
      const { getNextStudentRollNumber } = await import('../utils/studentRollNumber.js');
      roll = await getNextStudentRollNumber({ batchId: input.body.batch, batchName: 'Verification On Campus', batchType: 'On Campus', rollNickname: 'VERIFY' });
    }
    process.send({ preflight: true, journal: String(req.creationRequest._id), roll });
    await new Promise(() => {});
  } else if (mode === 'job') {
    await processCreationOnce({ perform: async (_request, job) => {
      process.send({ jobStarted: job.name });
      await new Promise(() => {});
    } });
  } else if (mode === 'claim') {
    let claimed = false;
    await processCreationOnce({ afterClaim: async (request) => {
      claimed = true;
      process.send({ claimed: true, token: request.leaseToken });
      await new Promise(() => {});
    } });
    if (!claimed) process.send({ claimed: false });
  } else throw new Error('Unknown verification mode');
} finally {
  await mongoose.disconnect();
  process.disconnect?.();
}
