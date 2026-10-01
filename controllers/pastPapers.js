import PastPapers from "../models/pastPapers.js";
import dotenv from "dotenv";
import { paginateQuery } from "../utils/pagination.js";
dotenv.config();

export const createPastPaper = async (req, res) => {
  const {
    questions,
    year,
    courseId,
  } = req.body;

  if (!Array.isArray(questions) || questions.length === 0) {
    return res
      .status(400)
      .json({ message: "Questions must be a non-empty array" });
  }

  try {
    
    const pastPapersArray = questions.map((question) => ({
      question,
      year,
      courseId,
    }));

    // Insert multiple documents into the PastPapers collection
    const savedPastPapers = await PastPapers.insertMany(pastPapersArray);

    res.status(201).json(savedPastPapers);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const updatePastPaper = async (req, res) => {
  const { id } = req.params;
  const { questions, year, courseId } = req.body;
  try {
    const updatedPastPaper = await PastPapers.findByIdAndUpdate(
      id,
      {
        questions,
        year,
        courseId,
      },
      { new: true, runValidators: true }
    );
    if (!updatedPastPaper) {
      return res.status(404).json({ message: "pastPapers not found" });
    }
    res.status(200).json(updatedPastPaper);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getAllPastPapers = async (req, res) => {
  try {
    const pastPapers = await paginateQuery({
      model: PastPapers,
      query: req.query,
      sort: { _id: -1 },
      populate: "courseId",
    });
    res.status(200).json(pastPapers);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getPastPaperById = async (req, res) => {
  const { id } = req.params;
  try {
    const pastPapers = await PastPapers.findById(id);
    if (!pastPapers) {
      return res.status(404).json({ message: "PastPapers not found" });
    }
    res.status(200).json(pastPapers);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getPastPaperByCourseAndYear = async (req, res) => {
    const { courseId, year } = req.body;
    
    try {
      const pastPapers = await PastPapers.find({ courseId: courseId, year: year });
      if (pastPapers.length === 0) {
        return res.status(404).json({ message: "No past papers found for the given course and year" });
      }
      res.status(200).json(pastPapers);
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  };
  
export const deletePastPaper = async (req, res) => {
  const { id } = req.params;
  try {
    const pastPapers = await PastPapers.findByIdAndDelete(id);
    if (!pastPapers) {
      return res.status(404).json({ message: "Past Papers not found" });
    }
    res.status(200).json({ message: "Past Papers deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
