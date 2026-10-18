import express from 'express';
import {register,login,getUsers,addUser,updateUser,deleteUser,getUser,changeAvatar, changePassword, forgotPassword, adminlogin, resetPasswordForAllStudents} from '../controllers/users.js';
import auth from '../middlewares/auth.js';
import { claimCreation, getCreationByKey, getCreationStatus, retryCreation } from '../utils/creationService.js';

const router = express.Router();

router.get('/',auth,getUsers)
router.get('/by-key/:key', auth, getCreationByKey('user'));
router.get('/:id/processing', auth, getCreationStatus('user'));
router.post('/:id/processing/retry', auth, retryCreation('user'));
router.get('/:id',auth,getUser)
router.post('/register', register);
router.post('/login', login);
router.post('/adminlogin', adminlogin);
router.post('/add',auth, claimCreation('user'), addUser);
router.post('/update/:id',auth, updateUser);
router.delete('/delete/:id',auth, deleteUser);
router.post('/avatar', auth, changeAvatar);
router.post('/changePassword', auth, changePassword);
router.post('/forgotPassword', forgotPassword);
router.post('/resetPasswordForAllStudents', auth, resetPasswordForAllStudents);


export default router;
