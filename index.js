import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import express from 'express';
import bodyParser from 'body-parser';
import mongoose from 'mongoose';
import cors from 'cors';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fileUpload from 'express-fileupload';
import usersRoutes from './routes/users.js';
import coursesRoutes from './routes/courses.js';
import teachersRoutes from './routes/teachers.js';
import batchesRoutes from './routes/batches.js';
import studentRoutes from './routes/students.js';
import seminarRoutes from './routes/seminars.js';
import rolesRoutes from './routes/roles.js';
import permissionsRoutes from './routes/permissions.js';
import seminarAttendeesRoutes from './routes/seminarAttendees.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
dotenv.config();

app.use(bodyParser.json({ limit: "30mb", extended: true }));
app.use(bodyParser.urlencoded({ limit: "30mb", extended: true }));
app.use(fileUpload());
app.use(cors());
app.get("/", (req, res) => res.send("Express on Vercel"));
app.use('/public', express.static(join(__dirname, 'public')));
app.use('/users', usersRoutes);
app.use('/courses', coursesRoutes);
app.use('/teachers', teachersRoutes);
app.use('/batches', batchesRoutes);
app.use('/students', studentRoutes);
app.use('/seminars', seminarRoutes);
app.use('/roles', rolesRoutes);
app.use('/permissions', permissionsRoutes);
app.use('/attendees',seminarAttendeesRoutes);

const CONNECTION_URL = process.env.MONGO_URI;
const PORT = process.env.PORT || 5000;

mongoose.connect(CONNECTION_URL)
    .then(() => app.listen(PORT, () => console.log(`Server Running on Port: http://localhost:${PORT}`)))
    .catch((error) => console.error(`Error connecting to the database: ${error.message}`));
