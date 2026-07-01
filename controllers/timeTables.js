import TimeTable from "../models/timeTables.js";
import Student from "../models/students.js";
import {
  isStudentRole,
  resolveStudentRecord,
  denyUnlessOwnStudent,
} from "../utils/studentScope.js";
import {
  isTeacherRole,
  getTeacherScope,
  resolveTeacherId,
  canAccessCourse,
} from "../utils/lmsAccess.js";
import jwt from "jsonwebtoken";
import fs from "fs";
import dotenv from "dotenv";
import { storage } from "../utils/firebase.js";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import moment from "moment-timezone";
dotenv.config();
const JWT_SECRET = process.env.JWT_SECRET;

export const createTimeTable = async (req, res) => {
  const { batch, course, teacher, start_time, end_time, day } = req.body;

  if (!batch || !course || !teacher || !start_time || !end_time || !day) {
    return res.status(400).json({ message: "All fields are required" });
  }

  try {
    const newTimeTable = new TimeTable({
      batch,
      course,
      teacher,
      start_time,
      end_time,
      day,
    });

    await newTimeTable.save();

    res.status(201).json(newTimeTable);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const updateTimeTable = async (req, res) => {
  const { id } = req.params;
  const { batch, course, teacher, start_time, end_time, day } = req.body;

  // Validate input
  if (!batch || !course || !teacher || !start_time || !end_time || !day) {
    return res.status(400).json({ message: "All fields are required" });
  }

  try {
    const updatedTimeTable = await TimeTable.findByIdAndUpdate(
      id,
      { batch, course, teacher, start_time, end_time, day },
      { new: true, runValidators: true } // Options to return the updated document and run validation
    );

    if (!updatedTimeTable) {
      return res.status(404).json({ message: "Timetable entry not found" });
    }

    res.status(200).json(updatedTimeTable);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getTimeTableById = async (req, res) => {
  const { id } = req.params;

  try {
    const timeTable = await TimeTable.findById(id);

    if (!timeTable) {
      return res.status(404).json({ message: "Timetable entry not found" });
    }

    res.status(200).json(timeTable);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
  export const getTodayTimeTables = async (req, res) => {
    try {
      const currentDate = moment().tz("Asia/Karachi").format("YYYY-MM-DD");
            const timeTables = await TimeTable.find({
              day: currentDate,
      })
        .populate("batch")
        .populate("course")
        .populate("teacher");

      res.status(200).json(timeTables);
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  };

export const deleteTimeTable = async (req, res) => {
  const { id } = req.params;

  try {
    const deletedTimeTable = await TimeTable.findByIdAndDelete(id);

    if (!deletedTimeTable) {
      return res.status(404).json({ message: "Timetable entry not found" });
    }

    res.status(200).json(deletedTimeTable);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getTimeTableByStudentId = async (req, res) => {
  const { id } = req.params;

  try {
    if (!(await denyUnlessOwnStudent(req, res, id))) {
      return;
    }

    const student = await Student.findById(id);

    if (!student) {
      return res.status(404).json({ message: "Student not found" });
    }

    const batch = student.batch;

    if (!batch) {
      return res
        .status(404)
        .json({ message: "Batch not found for the student" });
    }

    const currentDate = moment().tz("Asia/Karachi").format("YYYY-MM-DD");
    // Find the timetable by batch and date
    const timeTables = await TimeTable.find({
      batch,
      day: currentDate,
    })
      .populate("batch")
      .populate("course")
      .populate("teacher");

    if (!timeTables || timeTables.length === 0) {
      return res
        .status(404)
        .json({ message: "No timetable entries found for today" });
    }

    res.status(200).json(timeTables);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getAllTimeTables = async (req, res) => {
  try {
      let filter = {};

      if (isStudentRole(req)) {
        const student = await resolveStudentRecord(req);
        if (!student?.batch) {
          return res.status(200).json([]);
        }
        filter.batch = student.batch._id || student.batch;
      }

      if (isTeacherRole(req)) {
        const scope = await getTeacherScope(req);
        const teacherId = await resolveTeacherId(req);
        if (!scope?.batchIds?.length || !teacherId) {
          return res.status(200).json([]);
        }
        filter.batch = { $in: scope.batchIds };
        filter.course = { $in: scope.courseIds };
        filter.teacher = teacherId;
      }

      const timeTables = await TimeTable.find(filter).populate("batch").populate("course").populate("teacher");

      res.status(200).json(timeTables);

  } catch (error) {
      res.status(500).json({ message: error.message });
  }
}
