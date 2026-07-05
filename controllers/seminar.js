import Seminar from "../models/seminar.js";
import Attendee from "../models/seminarAttendees.js";
import moment from "moment-timezone";


export const addSeminar = async (req, res) => {
  const { name, date, time, description } = req.body;
  try {
    const newSeminar = new Seminar({ name, date, time, description });
    await newSeminar.save();
    res.status(200).json("Seminar added successfully");
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getSeminars = async (req, res) => {
  const { query, start_date, end_date } = req.query;
  try {
    const searchQuery = query ? query : "";
    const filter = {
      $or: [
        { name: { $regex: searchQuery, $options: "i" } },
        { description: { $regex: searchQuery, $options: "i" } },
      ],
    };

    if (start_date || end_date) {
      filter.date = {};
      if (start_date) filter.date.$gte = start_date;
      if (end_date) filter.date.$lte = end_date;
    }

    const seminars = await Seminar.paginate(
      filter,
      {
        page: parseInt(req.query.page),
        limit: parseInt(req.query.limit),
      }
    );
    res.status(200).json(seminars);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getSeminar = async (req, res) => {
  const { id } = req.params;
  try {
    const seminar = await Seminar.findById(id);
    res.status(200).json(seminar);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deleteSeminar = async (req, res) => {
  const { id } = req.params;
  try {
    await Seminar.findByIdAndDelete(id);
    res.status(200).json("Seminar deleted successfully");
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const updateSeminar = async (req, res) => {
  const { id } = req.params;
  const { name, date, time, description } = req.body;
  try {
    await Seminar.findByIdAndUpdate(id, { name, date, time, description });
    res.status(200).json("Seminar updated successfully");
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getTodaySeminars = async (req, res) => {
  const today = moment().tz("Asia/Karachi").startOf("day").format("YYYY-MM-DD");

  try {
    const seminars = await Seminar.find({ date: today });
    if (seminars.length > 0) {
      return res.status(200).json(seminars);
    } else {
      return res.status(200).json([]);
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};


export const getSeminarAttendeesCount = async (req, res) => {
  const seminars = await Seminar.find()
    .populate({
      path: "seminarAttendees",
      select: "_id",
      options: { limit: 1 },
      strictPopulate: false,
    })
    .lean({ virtuals: true })
    .exec();

  const seminarsWithCount = seminars.map((seminar) => {
    return {
      _id: seminar._id,
      name: seminar.name,
      count: seminarAttendees.seminar?.length,
    };
  });

  res.status(200).json(seminarsWithCount);
};
export const getSeminarsWithAttendeeCounts = async (req, res) => {
  try {
    const seminarsWithAttendeeCounts = await Attendee.aggregate([
      {
        $group: {
          _id: "$seminar",
          attendeeCount: { $sum: 1 },
        },
      },
      {
        $lookup: {
          from: "seminars", // Assuming your Seminar collection is named "seminars"
          localField: "_id",
          foreignField: "_id",
          as: "seminarDetails",
        },
      },
      {
        $unwind: "$seminarDetails",
      },
      {
        $project: {
          _id: 0,
          seminarId: "$_id",
          seminarDetails: 1,
          attendeeCount: 1,
        },
      },
    ]);

    return res.status(200).json(seminarsWithAttendeeCounts);
  } catch (error) {
    console.error("Error fetching seminars with attendee counts:", error);
    throw error;
  }
};

export const getallSeminarwithAttendees = async (req, res) => {
  try {
    const seminars = await Seminar.find().populate("seminarAttendees");

    const seminarWithAttendeesCount = seminars.map((seminar) => ({
      seminar: seminar,
      count: seminar.seminarAttendees.length,
    }));

    res.status(200).json(seminarWithAttendeesCount);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}
