import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import { Octokit } from "@octokit/rest";
import dotenv from "dotenv";

dotenv.config(); // Load environment variables

const app = express();
const port = 3000;

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const openaiApiKey = process.env.OPENAI_API_KEY;

app.use(bodyParser.json());

// Default GET endpoint
app.get("/", (req, res) => {
  res.send("You are running an AI Bot PR Code Explainer");
});

app.post("/webhook", async (req, res) => {
  console.log("Received webhook:", req.body); // Log incoming request body

  const action = req.body.action;
  const pr = req.body.pull_request;

  // React to 'opened' and 'synchronize' actions
  if (pr && (action === "opened" || action === "synchronize")) {
    const owner = pr.base.repo.owner.login;
    const repo = pr.base.repo.name;
    const prNumber = pr.number;

    const diffData = await octokit.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
      mediaType: {
        format: "diff",
      },
    });

    const commitId = pr.head.sha; // Get the latest commit SHA
    const changes = parseDiff(diffData.data);
    const reviewComments = await generateReviewComments(changes, commitId);

    await updateReviewComments(owner, repo, prNumber, reviewComments);

    res.status(200).send("Webhook received and processed");
  } else {
    res.status(400).send("Not a pull request event");
  }
});

function parseDiff(diff) {
  const files = diff.split("diff --git ").slice(1);
  return files.map((fileDiff) => {
    const [fileHeader, ...diffLines] = fileDiff.split("\n");
    const fileName = fileHeader.split(" ")[1].slice(2); // Extract the file name
    const changes = diffLines
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .map((line, index) => ({ line: line.slice(1), lineNumber: index + 1 }));
    return { fileName, changes };
  });
}

async function generateReviewComments(fileChanges, commitId) {
  const comments = [];
  const prefix = "This comment was generated by AI Bot:\n\n";

  for (const { fileName, changes } of fileChanges) {
    const explanation = await getExplanationFromChatGPT(
      changes.map((change) => change.line).join("\n")
    );
    comments.push({
      path: fileName,
      body: prefix + explanation,
      commit_id: commitId,
      line: changes[0].lineNumber,
    });
  }

  return comments;
}

async function getExplanationFromChatGPT(code) {
  const response = await axios.post(
    "https://api.openai.com/v1/completions",
    {
      model: "text-davinci-003", // Use the appropriate model name
      prompt: `Explain the following JavaScript code changes:\n\n${code}\n\nExplanation:`,
      max_tokens: 150,
      n: 1,
      stop: null,
      temperature: 0.7,
    },
    {
      headers: {
        Authorization: `Bearer ${openaiApiKey}`,
        "Content-Type": "application/json",
      },
    }
  );

  return response.data.choices[0].text.trim();
}

async function updateReviewComments(owner, repo, pullNumber, comments) {
  const existingComments = await octokit.pulls.listReviewComments({
    owner,
    repo,
    pull_number: pullNumber,
  });

  for (const comment of comments) {
    // Check if there is an existing comment for this path
    const existingComment = existingComments.data.find(
      (c) =>
        c.path === comment.path &&
        c.body.startsWith("This comment was generated by AI Bot:")
    );

    if (existingComment) {
      // Delete the existing comment
      await octokit.pulls.deleteReviewComment({
        owner,
        repo,
        comment_id: existingComment.id,
      });
    }

    // Post the new comment
    await octokit.pulls.createReviewComment({
      owner,
      repo,
      pull_number: pullNumber,
      body: comment.body,
      path: comment.path,
      commit_id: comment.commit_id,
      line: comment.line,
    });
  }
}

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
