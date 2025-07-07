const express = require("express");
const cors = require("cors");
require("dotenv").config();
const Stripe = require("stripe");
const admin = require("firebase-admin");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

const serviceAccount = require("./firebase_admin_key.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.sfxielf.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;
const stripe = Stripe(process.env.PAYMENT_GATEWAY_KEY); // get from your stripe dashboard

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();

    const db = client.db("parcelDB");
    const parcelCollection = db.collection("parcels");
    const paymentCollection = db.collection("payments");
    const usersCollection = db.collection("users");
    const ridersCollection = db.collection("riders");

    // Custom middlewares
    const verifyToken = async (req, res, next) => {
      const authHeader = req.headers.authorization;

      if (!authHeader) {
        return res.status(401).send({ message: "unAuthorized access" });
      }
      const token = authHeader.split(" ")[1];
      console.log(token);
      if (!token) {
        return res.status(401).send({ message: "unAuthorized access" });
      }

      // Verify token
      try {
        const decodedUser = await admin.auth().verifyIdToken(token);
        req.decoded = decodedUser;
        next();
      } catch (err) {
        res.status(401).send({ message: "Unauthorized - Invalid token" });
      }
    };

    const verifyEmailToken = async (req, res, next) => {
      const email = req.query.email || req.body.email || req.params.email;
      if (email !== req.decoded.email) {
        return res.status(403).send({ message: "Forbidden Access" });
      }
      next();
    };

    app.post("/users", async (req, res) => {
      const email = req.body.email;
      const emailExists = await usersCollection.findOne({ email });
      if (emailExists) {
        // update last log in
        const updateResult = usersCollection.updateOne(
          { email },
          {
            $set: {
              last_log_in: new Date().toISOString(),
            },
          }
        );
        return res.status(200).send({
          message: "user already exists",
          inserted: false,
          update: (await updateResult).modifiedCount > 0,
        });
      }
      const user = req.body;
      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    // Get all parcels OR parcels by user (create_by), sorted by latest
    app.get("/parcels", verifyToken, async (req, res) => {
      try {
        const userEmail = req.query.email;

        const query = userEmail ? { created_by: userEmail } : {};
        const options = {
          sort: { createdAt: -1 },
        };

        const parcels = await parcelCollection.find(query, options).toArray();
        res.send(parcels);
      } catch (error) {
        res.status(500).send({ message: "Server error", error: error.message });
      }
    });

    // get parcles search by id
    app.get("/parcels/:id", verifyToken, async (req, res) => {
      try {
        const id = req.params.id;

        if (!ObjectId.isValid(id)) {
          return res
            .status(400)
            .send({ success: false, message: "Invalid ID" });
        }

        const parcel = await parcelCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!parcel) {
          return res
            .status(404)
            .send({ success: false, message: "Parcel not found" });
        }

        res.send({ success: true, data: parcel });
      } catch (error) {
        res.status(500).send({ success: false, message: error.message });
      }
    });

    // Parcel add api
    app.post("/parcels", verifyToken, async (req, res) => {
      try {
        const newParcel = req.body;
        const result = await parcelCollection.insertOne(newParcel);
        res.status(201).send(result);
      } catch (err) {
        console.error("Error insertig parcel:", err);
        res.status(500).send({ message: "Failed to create parcel" });
      }
    });

    // Rider application post api
    app.post("/riders", async (req, res) => {
      const riderData = req.body;
      const result = await ridersCollection.insertOne(riderData);
      res.send(result);
    });

    // All pending riders
    app.get("/pending", async (req, res) => {
      try {
        const pendingRiders = await ridersCollection
          .find({ status: "pending" })
          .toArray();
        res.send(pendingRiders);
      } catch (error) {
        console.error("Error fetching pending riders:", error);
        res.status(500).send({ error: "Internal Server Error" });
      }
    });

    // Pending rider status update
    app.patch("/riders/:id", async (req, res) => {
      const id = req.params.id;
      const result = await ridersCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status: "approved" } }
      );
      res.send(result);
    });

    // Pending rider delele
    app.delete("/riders/:id", async (req, res) => {
      const id = req.params.id;
      const result = await ridersCollection.deleteOne({
        _id: new ObjectId(id),
      });
      res.send(result);
    });

    // Traking parcel post Api
    app.post("/tracking", async (req, res) => {
      const {
        traking_id,
        parcel_id,
        status,
        message,
        updated_by = "",
      } = req.body;
      const log = {
        traking_id,
        parcel_id: parcel_id ? new ObjectId(parcel_id) : undefined,
        status,
        message,
        time: new Date(),
        updated_by,
      };
      const result = await trackingCollection.insertOne(log);
      res.send({ success: true, insertedId: result.insertedId });
    });

    //MyParcel delete api
    app.delete("/parcels/:id", verifyToken, async (req, res) => {
      try {
        const id = req.params.id;

        const result = await parcelCollection.deleteOne({
          _id: new ObjectId(id),
        });

        if (result.deletedCount > 0) {
          res.send({ success: true, message: "Parcel deleted" });
        } else {
          res.status(404).send({ success: false, message: "Parcel not found" });
        }
      } catch (error) {
        res.status(500).send({ success: false, message: error.message });
      }
    });

    // payment history for user
    app.get("/payments/user/:email", verifyToken, async (req, res) => {
      const userEmail = req.params.email;

      try {
        const history = await paymentCollection
          .find({ userEmail })
          .sort({ paid_at: -1 }) // descending
          .toArray();

        res.send(history);
      } catch (error) {
        res.status(500).send({ error: "Could not fetch user payment history" });
      }
    });

    // payment history for admin
    app.get("/payments", verifyToken, async (req, res) => {
      try {
        const allPayments = await paymentCollection
          .find()
          .sort({ paid_at: -1 })
          .toArray();
        res.send(allPayments);
      } catch (error) {
        res.status(500).send({ error: "Could not fetch payment history" });
      }
    });

    // create payment intent api
    app.post("/create-payment-intent", async (req, res) => {
      const { amount } = req.body;

      try {
        const paymentIntent = await stripe.paymentIntents.create({
          amount: amount, // in cents
          currency: "usd",
          payment_method_types: ["card"],
        });

        res.send({
          clientSecret: paymentIntent.client_secret,
        });
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    // Update paymant and create payment history
    app.post("/payments", verifyToken, async (req, res) => {
      const { parcelId, userEmail, amount, transactionId } = req.body;

      try {
        // 1. Update parcel payment_status
        await parcelCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          { $set: { payment_status: "paid" } }
        );

        // 2. Save payment info
        const paymentDoc = {
          parcelId,
          userEmail,
          amount,
          transactionId,
          // paymentMethod,
          paid_at_string: new Date().toISOString(),
          paid_at: new Date(),
        };

        const result = await paymentCollection.insertOne(paymentDoc);

        res.send({ message: "Payment saved", paymentId: result.insertedId });
      } catch (error) {
        console.error("Error saving payment:", error);
        res.status(500).send({ error: "Payment failed" });
      }
    });

    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // await client.close();
  }
}
run().catch(console.dir);

// Test route
app.get("/", (req, res) => {
  res.send("FastFare Server is running...");
});

// Start server
app.listen(port, () => {
  console.log(`Server is listening on port ${port}`);
});
