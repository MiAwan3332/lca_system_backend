import Mcq from "../models/mcqs.js";
import dotenv from "dotenv";
dotenv.config();

const populateOptions = { path: "courseId", select: "name description fee" };

export const createMcq = async (req, res) => {
  const {
    question,
    option1,
    option2,
    option3,
    option4,
    correct_option,
    courseId,
  } = req.body;

  try {
    const newMcq = new Mcq({
      question,
      option1,
      option2,
      option3,
      option4,
      correct_option,
      courseId,
    });
    await newMcq.save();
    const populatedMcq = await Mcq.findById(newMcq._id).populate(populateOptions);
    res.status(201).json(populatedMcq);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const updateMcq = async (req, res) => {
  const { id } = req.params;
  const {
    question,
    option1,
    option2,
    option3,
    option4,
    correct_option,
    courseId,
  } = req.body;
  try {
    const updatedMcq = await Mcq.findByIdAndUpdate(
      id,
      {
        question,
        option1,
        option2,
        option3,
        option4,
        correct_option,
        courseId,
      },
      { new: true, runValidators: true }
    ).populate(populateOptions);
    if (!updatedMcq) {
      return res.status(404).json({ message: "Mcq not found" });
    }
    res.status(200).json(updatedMcq);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getAllMcqs = async (req, res) => {
  const { query, course_id } = req.query;

  try {
    const searchQuery = query ? query : "";
    const filter = {
      $or: [
        { question: { $regex: searchQuery, $options: "i" } },
        { option1: { $regex: searchQuery, $options: "i" } },
        { option2: { $regex: searchQuery, $options: "i" } },
        { option3: { $regex: searchQuery, $options: "i" } },
        { option4: { $regex: searchQuery, $options: "i" } },
      ],
    };

    if (course_id) {
      filter.courseId = course_id;
    }

    const mcqs = await Mcq.paginate(filter, {
      page: parseInt(req.query.page, 10) || 1,
      limit: parseInt(req.query.limit, 10) || 10,
      sort: { createdAt: -1 },
      populate: populateOptions,
    });
    res.status(200).json(mcqs);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getMcqById = async (req, res) => {
  const { id } = req.params;
  try {
    const mcq = await Mcq.findById(id).populate(populateOptions);
    if (!mcq) {
      return res.status(404).json({ message: "Mcq not found" });
    }
    res.status(200).json(mcq);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deleteMcq = async (req, res) => {
  const { id } = req.params;
  try {
    const mcq = await Mcq.findByIdAndDelete(id);
    if (!mcq) {
      return res.status(404).json({ message: "Mcq not found" });
    }
    res.status(200).json({ message: "Mcq deleted successfully", _id: id });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getMcqsByCourseId = async (req, res) => {
  const { id } = req.params;
  try {
    const mcqs = await Mcq.find({ courseId: id });

    if (!mcqs || mcqs.length === 0) {
      return res.status(404).json({ message: "MCQs not found" });
    }
    const formattedMcqs = mcqs.map((mcq) => {
      const options = [
        mcq.option1.trim(),
        mcq.option2.trim(),
        mcq.option3.trim(),
        mcq.option4.trim(),
      ];
      const correctOptionIndex = mcq.correct_option.trim();

      return {
        question: mcq.question,
        options: options,
        correctOptionIndex: correctOptionIndex,
      };
    });

    res.status(200).json({ MCQ: formattedMcqs });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
