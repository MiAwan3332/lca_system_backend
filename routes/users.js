import express from 'express';
import {register,login,getUsers,addUser,updateUser,deleteUser,getUser,changeAvatar, changePassword, forgotPassword, adminlogin, resetPasswordForAllStudents} from '../controllers/users.js';
import auth from '../middlewares/auth.js';

const router = express.Router();

router.get('/',auth,getUsers)
router.get('/:id',auth,getUser)
router.post('/register', register);
router.post('/login', login);
router.post('/adminlogin', adminlogin);
router.post('/add',auth, addUser);
router.post('/update/:id',auth, updateUser);
router.delete('/delete/:id',auth, deleteUser);
router.post('/avatar', auth, changeAvatar);
router.post('/changePassword', auth, changePassword);
router.post('/forgotPassword', forgotPassword);
router.post('/resetPasswordForAllStudents', auth, resetPasswordForAllStudents);


export default router;