const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
require("dotenv").config();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const app = express();
const port = process.env.PORT || 5000;
// middleware
app.use(cors());
app.use(express.json());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.o2q6h.mongodb.net/?retryWrites=true&w=majority`;
const client = new MongoClient(uri, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverApi: ServerApiVersion.v1,
});

function verifyJWT(req, res, next) {
  const authorization = req.headers.authorization;
  if (!authorization) {
    return res.status(401).send({ message: "UnAuthorized Access" });
  }
  const accessToken = authorization.split(" ")[1];
  jwt.verify(
    accessToken,
    process.env.ACCESS_TOKEN_SECRET,
    function (err, decoded) {
      if (err) {
        return res.status(403).send({ message: "Forbidden Access" });
      }
      req.decoded = decoded;
      next();
    }
  );
}

async function run() {
  try {
    await client.connect();
    const serviceCollection = client.db("doctors_portal").collection("services");
    const bookingCollection = client.db("doctors_portal").collection("bookings");
    const userCollection = client.db("doctors_portal").collection("users");
    const doctorCollection = client.db("doctors_portal").collection("doctors");
    const paymentCollection = client.db("doctors_portal").collection("payments");
    
    // this function for verifyAdmin 
    const verifyAdmin = async (req, res, next) => {
      const requester = req.decoded.email;
      const requesterAccount = await userCollection.findOne({email: requester,});
      if (requesterAccount.role === "admin") {
       next(); 
      }
      else{
        res.status(403).send({message:'Forbidden Access'})
      }
    }
    // this api for payment 
      app.post("/create-payment-intent", verifyJWT, async (req, res) => {
        const service = req.body;
        const price = service.price;
        const amount = price * 100;
        const paymentIntent = await stripe.paymentIntents.create({
          amount: amount,
          currency: "usd",
          payment_method_types: ["card"],
        });
        res.send({ clientSecret: paymentIntent.client_secret });
      });
    // this api for get service on appointment page
    app.get("/services", async (req, res) => {
      const query = {};
      const cursor = serviceCollection.find(query).project({name:1});
      const services = await cursor.toArray();
      res.send(services);
    });

    // this api for all users
    app.get("/user", verifyJWT, async (req, res) => {
      const users = await userCollection.find().toArray();
      res.send(users);
    });

    //this api for require admin
    app.get('/admin/:email',async (req ,res) => {
      const email = req.params.email;
      const user = await userCollection.findOne({email:email});
      const isAdmin = user.role === 'admin'
      res.send({admin:isAdmin}); 
    });

    // this api for make admin any users
    app.put("/user/admin/:email", verifyJWT, verifyAdmin, async (req, res) => {
      const email = req.params.email;
      const filter = { email: email };
      // const requester = req.decoded.email;
      // const requesterAccount = await userCollection.findOne({email: requester,});
      // if (requesterAccount.role === "admin") {
        const updateDoc = {
          $set: { role: 'admin' },
        };
        const result = await userCollection.updateOne(filter, updateDoc);
        res.send(result);
      // }
      // else{
      //   res.status(403).send({message:'Forbidden Access'})
      // }
    });

    // this api for update users on database
    app.put("/user/:email", async (req, res) => {
      const user = req.body;
      const email = req.params.email;
      const filter = { email: email };
      const options = { upsert: true };
      const updateDoc = {
        $set: user,
      };
      const result = await userCollection.updateOne(filter, updateDoc, options);
      const token = jwt.sign(
        { email: email },
        process.env.ACCESS_TOKEN_SECRET,
        { expiresIn: "30d" }
      );
      res.send({ result, accessToken: token });
    });

    /** Waring
     * This is not the proper way to query
     * After learning more about mongodb. use aggregate lookup, pipeline, match, group.
     */
    // this api for available appointment
    app.get("/available", async (req, res) => {
      const treatmentDate = req.query.date || "Oct 12, 2022";

      //step 1: get all services
      const services = await serviceCollection.find().toArray();
      //step 2: get the booking of that day. output:[{},{},{},{},{},{},{},{}]
      const query = { treatmentDate: treatmentDate };
      const bookings = await bookingCollection.find(query).toArray();
      //step 3: for each service,
      services.forEach((service) => {
        //step 4: find bookings that service. output:[{},{},{},{}]
        const serviceBookings = bookings.filter(
          (book) => book.treatmentName === service.name
        );
        //step 5: select slots for the service Bookings:['','','','',]
        const bookedSlots = serviceBookings.map((book) => book.slot);
        //step 6: select those slots that are not in bookingSlots
        const available = service.slots.filter(
          (slot) => !bookedSlots.includes(slot)
        );
        //step 7:set available to slots to make it easier
        service.slots = available;
      });
      res.send(services);
    });

    /* 

 * API Naming Convention
 * app.get('/booking')           // get all booking by this api 
 * app.get('/booking/:id')      //  get a specific booking
 * app.post('/booking')        //   add a new booking
 * app.put('/booking/:id')    //    upsert ==> (if exists) then update  or (if doesn't exist) then insert
 * app.patch('/booking/:id)  //     this for update on ko 
 * app.delete('/booking/:id)//      delete a specific booking

 */

    // this api for specific Appointment
    app.get("/booking", verifyJWT, async (req, res) => {
      const patientEmail = req.query.patientEmail;
      const decodedEmail = req.decoded.email;
      if (patientEmail === decodedEmail) {
        const query = { patientEmail: patientEmail };
        const bookings = await bookingCollection.find(query).toArray();
        return res.send(bookings);
      } else {
        return res.status(403).send({ message: "Forbidden Access" });
      }
    });

    // this api for all booking modal
    app.post("/booking", async (req, res) => {
      const booking = req.body;
      const query = {
        treatmentName: booking.treatmentName,
        treatmentDate: booking.treatmentDate,
        patientEmail: booking.patientEmail,
      };
      const exists = await bookingCollection.findOne(query);
      if (exists) {
        return res.send({ success: false, booking: exists });
      }
       else {
        const result = await bookingCollection.insertOne(booking);
        return res.send({ success: true, result });
      }
    });

    //this api for specific booking
    app.get('/booking/:id',verifyJWT , async (req, res)=>{
      const id = req.params.id;
      const query= {_id:ObjectId(id)};
      const booking = await bookingCollection.findOne(query);
      res.send(booking);
    }); 

    //this api for update payment status
    app.patch('/booking/:id', verifyJWT, async(req, res) =>{
      const payment=req.body;
      const id =req.params.id;
      const filter ={_id:ObjectId(id)};
      const updateDoc={
        $set:{
          paid:true,
          transactionId:payment.transactionId,
        }
      }
      const updatedBooking = await bookingCollection.updateOne(filter,updateDoc);
      const result = await paymentCollection.insertOne(payment);
      res.send (updatedBooking);
    });

    //this api for all doctors
    app.get('/doctor', verifyJWT, verifyAdmin, async (req, res)=>{
      const doctors = await doctorCollection.find().toArray();
      res.send(doctors);
    });

    //this api for add doctors
    app.post('/doctor', verifyJWT, verifyAdmin, async (req, res) => {
      const doctor = req.body;
      const result = await doctorCollection.insertOne(doctor);
      res.send(result); 
    });
    //this api for delete doctors
    app.delete('/doctor/:email', verifyJWT, verifyAdmin, async (req, res) => {
      const email = req.params.email;
      const filter ={email:email}
      const result = await doctorCollection.deleteOne(filter);
      res.send(result); 
    });
   




  } 
  
  finally {
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Hello From Doctor Uncle");
});

app.listen(port, () => {
  console.log("Doctors Portal Listening On Port", port);
});
