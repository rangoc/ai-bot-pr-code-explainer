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

    // console.log("diffData", diffData.data);

    const commitId = pr.head.sha; // Get the latest commit SHA

    console.log("commitId", commitId);

    const parsedDiff = parseDiff(diffData.data);

    console.log("parsedDiff", parsedDiff);

    parsedDiff.map((file) => {
      console.log("fileChanges", file.changes[0]);
    });

    // const fileChanges = await fetchFileContents(
    //   owner,
    //   repo,
    //   parsedDiff,
    //   commitId
    // );

    // console.log("fileChanges", fileChanges);

    // const reviewComments = await generateReviewComments(fileChanges, commitId);

    // console.log("reviewComments", reviewComments);

    // await updateReviewComments(owner, repo, prNumber, reviewComments);

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
      .map((line) => ({ line: line.slice(1).trim() }));
    return { fileName, changes };
  });
}

async function fetchFileContents(owner, repo, parsedDiff, commitId) {
  return await Promise.all(
    parsedDiff.map(async (file) => {
      const fileContent = await getFileContent(
        owner,
        repo,
        file.fileName,
        commitId
      );
      return { ...file, fileContent };
    })
  );
}

async function getFileContent(owner, repo, path, commitId) {
  const result = await octokit.repos.getContent({
    owner,
    repo,
    path,
    ref: commitId, // Specify the commit SHA as the reference
  });

  const content = Buffer.from(result.data.content, "base64").toString("utf-8");
  return content;
}

async function generateReviewComments(fileChanges, commitId) {
  const comments = [];
  const prefix = "This comment was generated by AI Bot:\n\n";

  for (const { fileName, fileContent, changes } of fileChanges) {
    // const explanation = await getExplanationFromChatGPT(fileContent, changes);
    comments.push({
      path: fileName,
      body: prefix + "Here goes the explanation from GPT-3",
      commit_id: commitId,
    });
  }

  return comments;
}

async function getExplanationFromChatGPT(fileContent, changes) {
  const codeChanges = changes.map((change) => change.line).join("\n");
  const prompt = `Here's a file with JavaScript code:\n\n${fileContent}\n\nThe following lines have been changed:\n\n${codeChanges}\n\nPlease explain these changes:`;

  const response = await axios.post(
    "https://api.openai.com/v1/completions",
    {
      model: "davinci-002", // Use the appropriate model name
      prompt: prompt,
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
      subject_type: "file",
    });
  }
}

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
