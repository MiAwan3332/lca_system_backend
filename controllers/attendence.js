import Attendence from "../models/attendence.js";
import Batch from "../models/batches.js";
import Student from "../models/students.js";
import Course from "../models/courses.js";
import TimeTable from "../models/timeTables.js";
import Enrollment from "../models/enrollments.js";
import {
  isStudentRole,
  resolveStudentId,
  denyUnlessOwnStudent,
} from "../utils/studentScope.js";
import {
  isTeacherRole,
  applyTeacherBatchFilter,
  applyTeacherCourseFilter,
  buildEmptyPaginatedResponse,
} from "../utils/lmsAccess.js";
import moment from "moment-timezone";
import mongoose from "mongoose";

export const createAttendence = async (req, res) => {
  const { student_id } = req.body;
  try {
    const student = await Student.findById(student_id);
    if (!student) {
      return res.status(400).json({ message: "Student not found" });
    }

    const currentTime = moment().tz("Asia/Karachi").format("HH:mm");
    const currentDay = moment().tz("Asia/Karachi").format("YYYY-MM-DD");

    const timetable = await TimeTable.find({
      day: currentDay,
      batch: student.batch,
      start_time: { $lte: currentTime },
      end_time: { $gte: currentTime },
    })
      .populate("batch")
      .populate("course")
      .exec();
    if (!timetable) {
      return res
        .status(400)
        .json({ message: "No class is scheduled at the moment" });
    }
    const timetable_courses_ids = timetable.map((t) => t.course._id);

    const enrollment = await Enrollment.findOne({
      student: student_id,
      batch: student.batch,
    });
    if (!enrollment) {
      return res
        .status(400)
        .json({ message: "Student is not enrolled in any course" });
    }
    const enrollment_courses_ids = enrollment.courses;

    const course_id = timetable_courses_ids.find((id) =>
      enrollment_courses_ids.includes(id)
    );

    console.log(timetable_courses_ids);
    console.log(enrollment_courses_ids);
    console.log(course_id);
    
    if (!course_id) {
      return res.status(400).json({
        message: "No class is scheduled for this student at the moment " ,
        timetable: timetable_courses_ids,
        enrollment: enrollment_courses_ids,
        course_id: course_id
      });
    }

    const attendence = await Attendence.find({
      student: student_id,
      batch: student.batch,
      course: course_id,
      date: currentDay,
    })
      .populate("course")
      .exec();
    if (attendence.length > 0) {
      return res.status(400).json({ message: "Attendence already marked" });
    }

    const newAttendence = new Attendence({
      course: course_id,
      batch: student.batch,
      student: student_id,
      date: currentDay,
      status: "Present",
    });

    await newAttendence.save();

    res.status(200).json({
      message: "Attendence marked successfully",
      attendence: newAttendence,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getAttendences = async (req, res) => {
  const { query, course_id, batch_id, date } = req.query;
  try {
    const searchQuery = query ? query : "";

    const filter = {};

    if (isStudentRole(req)) {
      const studentId = await resolveStudentId(req);
      if (!studentId) {
        return res.status(404).json({ message: "Student profile not found" });
      }
      filter.student = studentId;
    }

    if (course_id) filter.course = course_id;
    if (batch_id) filter.batch = batch_id;
    if (date) filter.date = date;

    if (isTeacherRole(req)) {
      await applyTeacherBatchFilter(req, filter, "batch");
      await applyTeacherCourseFilter(req, filter, "course");
      if (filter.batch?.$in?.length === 0 || filter.course?.$in?.length === 0) {
        return res.status(200).json(buildEmptyPaginatedResponse(parseInt(req.query.limit, 10) || 10));
      }
    }

    const options = {
      page: parseInt(req.query.page, 10) || 1,
      limit: parseInt(req.query.limit, 10) || 10,
      sort: { date: -1 },
      populate: [
        { path: "course" },
        { path: "batch" },
        {
          path: "student",
          match: {
            name: { $regex: searchQuery, $options: "i" },
          },
        },
      ],
    };

    const attendences = await Attendence.paginate(filter, options);

    // Filter out attendances where student is null (didn't match the regex)
    attendences.docs = attendences.docs.filter((a) => a.student != null);

    res.status(200).json(attendences);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getAttendanceByStudentId = async (req, res) => {
  const { student_id } = req.params;
  try {
    // First, get enrollment data based on student_id
    const enrollments = await Enrollment.find({ student: student_id }).populate('courses');

    if (!enrollments.length) {
      return res
        .status(404)
        .json({ message: "No enrollments found for this student." });
    }

    // Create a map to store attendance status for each course
    const attendanceMap = {};

    for (const enrollment of enrollments) {
      const attendance = await Attendence.find({
        student: student_id,
        course: enrollment.courses._id,
      });

      attendanceMap[enrollment.course._id] = {
        course: enrollment.course,
        status: attendance.length ? "Present" : "Absent",
      };
    }

    const attendanceData = Object.values(attendanceMap);

    res.status(200).json(attendanceData);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getTodayAttendenceByStudentId = async (req, res) => {
  const { student_id } = req.params;
  try {
    if (!(await denyUnlessOwnStudent(req, res, student_id))) {
      return;
    }

    const attendence = await Attendence.find({
      student: student_id,
      date: moment().tz("Asia/Kolkata").format("YYYY-MM-DD"),
    }).populate("course");
    res.status(200).json(attendence);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};