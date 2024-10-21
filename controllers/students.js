import Student from "../models/students.js";
import Batch from "../models/batches.js";
import User from "../models/users.js";
import { addEmailToQueue } from "../utils/emailQueue.js";
import dotenv, { populate } from "dotenv";
import QRCode from "qrcode";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { compressImage, uploadFile } from "../utils/fileStorage.js";
import path from "path";
dotenv.config();

// const crypto = require("crypto");

export const addStudent = async (req, res) => {
  const { name, email, phone } = req.body;
  const admission_date = req.body.admission_date || new Date();

  try {
    // Check if the email already exists
    const existingStudent = await Student.findOne({ email });
    if (existingStudent) {
      return res.status(400).json({ message: "Email already exists" });
    }

    // Generate a random password
    // const randomPassword = crypto.randomBytes(4).toString("hex"); 
    const randomPassword = "lca@123456";

    // Hash the password
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(randomPassword, saltRounds);

    if (await User.findOne({ email })) {
      return res.status(400).json({ message: "Email already exists" });
    }

    const newUser = new User({
      name,
      email,
      password: hashedPassword, // Save the hashed password
      role: "student", // Assign the role
    });

    await newUser.save();

    const newStudent = new Student({
      name,
      email,
      phone,
      admission_date,
      total_fee: 0,
      paid_fee: 0,
      pending_fee: 0,
      password: hashedPassword, // Save the hashed password
      cnic: "",
      date_of_birth: "",
      father_name: "",
      father_phone: "",
      latest_degree: "",
      university: "",
      city: "",
      completion_year: "",
      marks_cgpa: "",
      cnic_image: "",
      cnic_back_image: "",
      image: "",
    });

    await newStudent.save();

    await generateQrCode(newStudent._id);

    // Send welcome email to the student with the random password
    // await addEmailToQueue(email, name, randomPassword);

    res.status(200).json("Student Added Successfully");
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getStudents = async (req, res) => {
  const { query } = req.query;
  try {
    const searchQuery = query ? query : "";
    const students = await Student.paginate(
      {
        $or: [
          { name: { $regex: searchQuery, $options: "i" } },
          { email: { $regex: searchQuery, $options: "i" } },
          { phone: { $regex: searchQuery, $options: "i" } },
        ],
      },
      {
        page: parseInt(req.query.page),
        limit: parseInt(req.query.limit),
        populate: ["batch"],
      }
    );
    res.status(200).json(students);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getStudent = async (req, res) => {
  const { id } = req.params;
  try {
    const student = await Student.findById(id);
    res.status(200).json(student);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deleteStudent = async (req, res) => {
  const { id } = req.params;
  try {
    const student = await Student.findById(id);
    if (!student) {
      return res.status(404).json({ message: "Student not found" });
    }
    await User.findOneAndDelete({ email: student.email });
    await Student.findByIdAndDelete(id);
    res.status(200).json("student deleted successfully");
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const updateStudent = async (req, res) => {
  const { id } = req.params;
  const {
    name,
    email,
    phone,
    cnic,
    admission_date,
    city,
    date_of_birth,
    father_name,
    father_phone,
    latest_degree,
    university,
    completion_year,
    marks_cgpa,
    batch,
    paid_fee,
    pending_fee,
    total_fee,
  } = req.body;
  const { image, cnic_image, cnic_back_image, latest_degree_image } = req.files;

  try {
    const student = await Student.findById(id);
    if (!student) {
      return res.status(404).json({ message: "Student not found" });
    }

    // Check if the new email is already in use by another student
    if (email && email !== student.email) {
      const existingStudent = await Student.findOne({ email });
      if (existingStudent) {
        return res.status(400).json({ message: "Email already exists" });
      }
    }

    const filesStorageUrl = process.env.FILES_STORAGE_URL;
    const filesStoragePath = process.env.FILES_STORAGE_PATH;

    // Save image to File Storage
    const imageFile = image;
    const imageFileExt = path.extname(imageFile.name);
    const imageFileName = `avatar_${id}${imageFileExt}`;
    await uploadFile(imageFile, imageFileName, `${filesStoragePath}/students/avatars`);
    const imageWebpFileName = `avatar_${id}.jpeg`;
    await compressImage(`${filesStoragePath}/students/avatars/${imageFileName}`, `${filesStoragePath}/students/avatars/${imageWebpFileName}`, 50);
    const imagePath = `${filesStorageUrl}/files/students/avatars/${imageWebpFileName}`

    // Save CNIC image to Firebase storage
    const cnicImageFile = cnic_image;
    const cnicImageFileExt = path.extname(cnicImageFile.name);
    const cnicImageFileName = `cnic_front_${id}${cnicImageFileExt}`;
    await uploadFile(cnicImageFile, cnicImageFileName, `${filesStoragePath}/students/cnic_images`);
    const cnicImageWebpFileName = `cnic_front_${id}.jpeg`;
    await compressImage(`${filesStoragePath}/students/cnic_images/${cnicImageFileName}`, `${filesStoragePath}/students/cnic_images/${cnicImageWebpFileName}`, 50);
    const cnic_imagePath = `${filesStorageUrl}/files/students/cnic_images/${cnicImageWebpFileName}`

    // Save CNIC back image to Firebase storage
    const cnicBackImageFile = cnic_back_image;
    const cnicBackImageFileExt = path.extname(cnicBackImageFile.name);
    const cnicBackImageFileName = `cnic_back_${id}${cnicBackImageFileExt}`;
    await uploadFile(cnicBackImageFile, cnicBackImageFileName, `${filesStoragePath}/students/cnic_images`);
    const cnicBackImageWebpFileName = `cnic_back_${id}.jpeg`;
    await compressImage(`${filesStoragePath}/students/cnic_images/${cnicBackImageFileName}`, `${filesStoragePath}/students/cnic_images/${cnicBackImageWebpFileName}`, 50);
    const cnic_back_imagePath = `${filesStorageUrl}/files/students/cnic_images/${cnicBackImageWebpFileName}`

    
    // Save Letest Degree image to Firebase storage
    const latestDegreeImageFile = latest_degree_image;
    const latestDegreeImageFileExt = path.extname(latestDegreeImageFile.name);
    const latestDegreeImageFileName = `latest_degree_${id}${latestDegreeImageFileExt}`;
    await uploadFile(latestDegreeImageFile, latestDegreeImageFileName, `${filesStoragePath}/students/latest_degree`);
    const latestDegreeImageWebpFileName = `latest_degree_${id}.jpeg`;
    await compressImage(`${filesStoragePath}/students/latest_degree/${cnicBackImageFileName}`, `${filesStoragePath}/students/cnic_images/${cnicBackImageWebpFileName}`, 50);
    const latest_degree_imagePath = `${filesStorageUrl}/files/students/latest_degree/${latestDegreeImageWebpFileName}`

    // Update the student record
    await Student.findByIdAndUpdate(id, {
      name,
      email,
      phone,
      cnic,
      admission_date,
      city,
      date_of_birth,
      father_name,
      father_phone,
      latest_degree,
      university,
      completion_year,
      marks_cgpa,
      batch,
      cnic_image: cnic_imagePath,
      image: imagePath,
      cnic_back_image: cnic_back_imagePath,
      latest_degree_image: latest_degree_imagePath,
      paid_fee,
      pending_fee,
      total_fee,
    });

    res.status(200).json("Student updated successfully");
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const generateQrCode = async (studentId) => {
  let newQrCode = null;
  try {
    // Generate QR code
    QRCode.toString(
      studentId.toString(),
      {
        errorCorrectionLevel: "H",
        type: "svg",
      },
      async function (err, data) {
        if (err) throw err;
        await Student.findByIdAndUpdate(studentId, { qrcode: data });
        newQrCode = data;
      }
    );
  } catch (error) {
    console.log(error);
  }
  return newQrCode;
};

export const getQrCode = async (req, res) => {
  const { id } = req.params;
  try {
    const student = await Student.findById(id);
    if (!student) {
      return res.status(404).json({ message: "Student not found" });
    }

    await generateQrCode(student._id);

    res.status(200).json((await Student.findById(student._id)).qrcode);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const updateStudentinfo = async (req, res) => {
  const { id } = req.params;
  const {
    cnic,
    city,
    date_of_birth,
    father_name,
    father_phone,
    latest_degree,
    university,
    completion_year,
    marks_cgpa,
  } = req.body;
  const { image, cnic_image, cnic_back_image, latest_degree_image } = req.files;

  try {
    const student = await Student.findById(id);
    if (!student) {
      return res.status(404).json({ message: "Student not found" });
    }

    const filesStorageUrl = process.env.FILES_STORAGE_URL;
    const filesStoragePath = process.env.FILES_STORAGE_PATH;

    // Save image to File Storage
    const imageFile = image;
    const imageFileExt = path.extname(imageFile.name);
    const imageFileName = `avatar_${id}${imageFileExt}`;
    await uploadFile(imageFile, imageFileName, `${filesStoragePath}/students/avatars`);
    const imageWebpFileName = `avatar_${id}.jpeg`;
    await compressImage(`${filesStoragePath}/students/avatars/${imageFileName}`, `${filesStoragePath}/students/avatars/${imageWebpFileName}`, 50);
    const imagePath = `${filesStorageUrl}/files/students/avatars/${imageWebpFileName}`

    // Save CNIC image to Firebase storage
    const cnicImageFile = cnic_image;
    const cnicImageFileExt = path.extname(cnicImageFile.name);
    const cnicImageFileName = `cnic_front_${id}${cnicImageFileExt}`;
    await uploadFile(cnicImageFile, cnicImageFileName, `${filesStoragePath}/students/cnic_images`);
    const cnicImageWebpFileName = `cnic_front_${id}.jpeg`;
    await compressImage(`${filesStoragePath}/students/cnic_images/${cnicImageFileName}`, `${filesStoragePath}/students/cnic_images/${cnicImageWebpFileName}`, 50);
    const cnic_imagePath = `${filesStorageUrl}/files/students/cnic_images/${cnicImageWebpFileName}`

    // Save CNIC back image to Firebase storage
    const cnicBackImageFile = cnic_back_image;
    const cnicBackImageFileExt = path.extname(cnicBackImageFile.name);
    const cnicBackImageFileName = `cnic_back_${id}${cnicBackImageFileExt}`;
    await uploadFile(cnicBackImageFile, cnicBackImageFileName, `${filesStoragePath}/students/cnic_images`);
    const cnicBackImageWebpFileName = `cnic_back_${id}.jpeg`;
    await compressImage(`${filesStoragePath}/students/cnic_images/${cnicBackImageFileName}`, `${filesStoragePath}/students/cnic_images/${cnicBackImageWebpFileName}`, 50);
    const cnic_back_imagePath = `${filesStorageUrl}/files/students/cnic_images/${cnicBackImageWebpFileName}`

    // Save Letest Degree image to Firebase storage
    const latestDegreeImageFile = latest_degree_image;
    const latestDegreeImageFileExt = path.extname(latestDegreeImageFile.name);
    const latestDegreeImageFileName = `latest_degree_${id}${latestDegreeImageFileExt}`;
    await uploadFile(latestDegreeImageFile, latestDegreeImageFileName, `${filesStoragePath}/students/latest_degree`);
    const latestDegreeImageWebpFileName = `latest_degree_${id}.jpeg`;
    await compressImage(`${filesStoragePath}/students/latest_degree/${cnicBackImageFileName}`, `${filesStoragePath}/students/latest_degree/${cnicBackImageWebpFileName}`, 50);
    const latest_degree_imagePath = `${filesStorageUrl}/files/students/latest_degree/${latestDegreeImageWebpFileName}`

    // Update the student record
    await Student.findByIdAndUpdate(id, {
      cnic,
      city,
      date_of_birth,
      father_name,
      father_phone,
      latest_degree,
      university,
      completion_year,
      marks_cgpa,
      cnic_image: cnic_imagePath,
      image: imagePath,
      cnic_back_image: cnic_back_imagePath,
      latest_degree_image: latest_degree_imagePath,
    });

    res.status(200).json("Student updated successfully");
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const checkStudentFields = async (req, res) => {
  const { id } = req.params;

  try {
    // Retrieve student by ID
    const student = await Student.findById(id);
    if (!student) {
      return res.status(404).json({ message: "Student not found" });
    }

    // Check for empty fields
    const fieldsToCheck = {
      cnic: student.cnic,
      city: student.city,
      date_of_birth: student.date_of_birth,
      father_name: student.father_name,
      father_phone: student.father_phone,
      latest_degree: student.latest_degree,
      university: student.university,
      completion_year: student.completion_year,
      marks_cgpa: student.marks_cgpa,
      image: student.image,
      cnic_image: student.cnic_image,
      cnic_back_image: student.cnic_back_image,
    };

    const emptyFields = Object.keys(fieldsToCheck).filter(
      (key) => !fieldsToCheck[key]
    );

    if (emptyFields.length > 0) {
      return res
        .status(400)
        .json({ message: "Empty fields found", emptyFields, check: 0 });
    }

    res.status(200).json({ message: "All fields are filled", check: 1 });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const basicStudentUpdate = async (req, res) => {
  const { id } = req.params;
  const { name, phone, paid_fee } = req.body;

  try {
    const student = await Student.findById(id);
    if (!student) {
      return res.status(404).json({ message: "Student not found" });
    }

    const newPaidFee = student.paid_fee + paid_fee;
    const pendingFee =
      student.total_fee > newPaidFee ? student.total_fee - newPaidFee : 0;

    await Student.findByIdAndUpdate(id, {
      name,
      phone,
      paid_fee: newPaidFee,
      pending_fee: pendingFee,
    });

    res.status(200).json("Student updated successfully");
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getStudentsGraph = async (req, res) => {
  try {
    const currentYear = new Date().getFullYear();
    const months = Array.from(
      { length: 12 },
      (_, i) => new Date(currentYear, i, 1)
    ).map((date) => ({
      date,
      month: date.toLocaleString("default", { month: "long" }),
    }));

    const studentCounts = await Promise.all(
      months.map(async ({ date }) => {
        const students = await Student.find({
          admission_date: {
            $gte: date,
            $lt: new Date(date.getFullYear(), date.getMonth() + 1, 1),
          },
        });
        return students.length;
      })
    );

    const data = months.map(({ month, date }, index) => ({
      [month]: studentCounts[index],
      date,
    }));
    res.json(data);
  } catch (error) {
    console.error("Error fetching student data:", error);
    res.status(500).send(error);
  }
};

export const getStudentsByBatchesGraph = async (req, res) => {
  try {
    const batches = await Batch.find();

    const studentCounts = await Promise.all(
      batches.map(async (batch) => {
        const count = await Student.countDocuments({ batch: batch._id });
        return { batch: batch.name, count };
      })
    );

    res.json(studentCounts);
  } catch (error) {
    console.error("Error fetching student data:", error);
    res.status(500).send(error);
  }
};

export const getStudentsContacts = async (req, res) => {
  const { query } = req.query;
  try {
    const searchQuery = query ? query : "";
    const students = await Student.find();
    // Extracting phone numbers from students
    const studentPhones = students.map(student => student.phone);
    res.status(200).json({ total: studentPhones.length, phones: studentPhones });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
