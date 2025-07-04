const express = require("express");
const cors = require("cors");
require("dotenv").config();
const Stripe = require("stripe");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

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

    const parcelCollection = client.db("parcelDB").collection("parcels");
    const paymentCollection = client.db("parcelDB").collection("payments");

    // Get all parcels OR parcels by user (create_by), sorted by latest
    app.get("/parcels", async (req, res) => {
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

    // get id search by id
    app.get("/parcels/:id", async (req, res) => {
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
    app.post("/parcels", async (req, res) => {
      try {
        const newParcel = req.body;
        const result = await parcelCollection.insertOne(newParcel);
        res.status(201).send(result);
      } catch (err) {
        console.error("Error insertig parcel:", err);
        res.status(500).send({ message: "Failed to create parcel" });
      }
    });

    //MyParcel delete api
    app.delete("/parcels/:id", async (req, res) => {
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
    app.get("/payments/user/:email", async (req, res) => {
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
    app.get("/payments", async (req, res) => {
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
    app.post("/payments", async (req, res) => {
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
