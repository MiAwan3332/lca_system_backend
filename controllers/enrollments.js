import Enrollment from "../models/enrollments.js";
import Student from "../models/students.js";
import moment from "moment";
import Batches from "../models/batches.js";

export const getEnrollments = async (req, res) => {
  try {
    const enrollments = await Enrollment.find();
    res.status(200).json(enrollments);
  } catch (error) {
    res.status(404).json({ message: error.message });
  }
};

export const createEnrollment = async (req, res) => {
  const { student_id, enrollments } = req.body;
  try {
    let total_fee = 0;
    let activeBatch = null;

    for (const enrollment of enrollments) {
      const { batch, courses, fees } = enrollment;

      for (let i = 0; i < fees.length; i++) {
        total_fee += parseInt(fees[i]);
      }

      const curBatch = await Batches.findById(batch);

      const start_date = moment(curBatch.start_date);
      const end_date = moment(curBatch.end_date);

      if (!activeBatch && courses.length > 0) {
        activeBatch = curBatch;
      }

      await Enrollment.updateOne(
        { student: student_id, batch },
        {
          $set: {
            courses,
            fees,
          },
        },
        { upsert: true }
      );
    }

    const student = await Student.findById(student_id);

    await Student.updateOne(
      { _id: student_id },
      {
        $set: {
          total_fee,
          pending_fee: total_fee - parseInt(student.paid_fee) || 0,
          paid_fee: parseInt(student.paid_fee) || 0,
          batch: activeBatch,
        },
      }
    );

    res.status(201).json({ message: "Enrollment created successfully" });
  } catch (error) {
    res.status(409).json({ message: error.message });
  }
};

export const getEntrollmentbyStudent = async (req, res) => {
  const { id } = req.params;
  try {
    const enrollment = await Enrollment.find({ student: id });
    res.status(200).json(enrollment);
  } catch (error) {
    res.status(404).json({ message: error.message });
  }
};
