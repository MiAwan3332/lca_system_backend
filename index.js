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
import attendenceRoutes from './routes/attendence.js';
import timetableRoutes from './routes/timeTables.js';
import enrollmentRoutes from './routes/enrollments.js';
import statisticsRoutes from './routes/statistics.js';
import mcqsRoutes from './routes/mcqs.js';
import pastPaperRoutes from './routes/pastPapers.js';
import feesRoutes from './routes/fees.js';
import expensesRoutes from './routes/expenses.js';
import quizRoutes from './routes/quiz.js';

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
app.use('/attendence',attendenceRoutes);
app.use('/timetable',timetableRoutes);
app.use('/enrollments',enrollmentRoutes);
app.use('/statistics', statisticsRoutes);
app.use('/mcqs', mcqsRoutes);
app.use('/pastPapers', pastPaperRoutes);
app.use('/fees', feesRoutes);
app.use('/expenses', expensesRoutes);
app.use('/quiz', quizRoutes);

const CONNECTION_URL = process.env.MONGO_URI;
const PORT = process.env.PORT || 5000;

mongoose.connect(CONNECTION_URL)
    .then(() => app.listen(PORT, () => console.log(`Server Running on Port: http://localhost:${PORT}`)))
    .catch((error) => console.error(`Error connecting to the database: ${error.message}`));