import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import { App } from "@octokit/app";
import dotenv from "dotenv";
import fs from "fs";
import Queue from "bull";
import { ExpressAdapter } from "@bull-board/express";
import { createBullBoard } from "@bull-board/api";
import { BullAdapter } from "@bull-board/api/dist/src/queueAdapters/bull.js";

dotenv.config(); // Load environment variables

const app = express();
const port = 3000;

// Read the private key file
const privateKey = fs.readFileSync(
  `${process.env.HOME}/Desktop/Work/Dlabs/Hackaton/chadreviewer.2024-08-06.private-key.pem`,
  "utf8"
);

const githubApp = new App({
  appId: process.env.GITHUB_APP_ID, // Your GitHub App ID
  privateKey: privateKey, // The private key content
});

const installationId = process.env.GITHUB_APP_INSTALLATION_ID; // Your installation ID
const openaiApiKey = process.env.OPENAI_API_KEY;

app.use(bodyParser.json());

// Create a queue for processing webhooks
const webhookQueue = new Queue("webhookQueue");

// Set up a dashboard for monitoring the queue
const serverAdapter = new ExpressAdapter();
createBullBoard({
  queues: [new BullAdapter(webhookQueue)],
  serverAdapter: serverAdapter,
});
serverAdapter.setBasePath("/admin/queues");
app.use("/admin/queues", serverAdapter.getRouter());

app.get("/", (req, res) => {
  res.send("You are running an AI Bot PR Code Explainer");
});

// Simplified webhook handler for testing
app.post("/webhook", async (req, res) => {
  const event = req.headers["x-github-event"];

  // Simulate event handling
  if (event === "pull_request") {
    const action = req.body.action;

    if (action === "opened" || action === "synchronize") {
      // Add job to the queue
      webhookQueue.add({ payload: req.body });
    }
  }

  res.status(200).send("Webhook received");
});

webhookQueue.process(async (job) => {
  const { payload } = job.data;
  await handlePullRequest({ payload });
});

async function handlePullRequest({ payload }) {
  try {
    const action = payload.action;
    const pr = payload.pull_request;

    if (pr && (action === "opened" || action === "synchronize")) {
      const owner = pr.base.repo.owner.login;
      const repo = pr.base.repo.name;
      const prNumber = pr.number;

      // Get the Octokit instance for the specific installation
      const octokit = await githubApp.getInstallationOctokit(installationId);

      if (!octokit) {
        throw new Error("Failed to obtain Octokit instance");
      }

      const headCommitSha = pr.head.sha; // Get the latest commit SHA
      const baseCommitSha = await getBaseCommitSha(
        octokit,
        owner,
        repo,
        headCommitSha
      ); // Get the base commit SHA for comparison

      const diffData = await octokit.request(
        `GET /repos/${owner}/${repo}/compare/${baseCommitSha}...${headCommitSha}`
      ); // Compare the base and head commits to get the diff

      const parsedDiff = parseDiff(diffData.data); // Parse the diff to get the list of changed files

      const filteredDiff = filterIgnoredFiles(parsedDiff); // Filter out ignored files

      const fileChanges = await fetchFileContents(
        octokit,
        owner,
        repo,
        filteredDiff,
        headCommitSha
      ); // Fetch the content of each changed file

      const { comments, removedFiles } = await generateReviewComments(
        fileChanges,
        headCommitSha
      ); // Generate review comments for the changed files

      // Ensure no duplicate comments
      const uniqueComments = Array.from(
        new Set(comments.map((c) => JSON.stringify(c)))
      ).map((str) => JSON.parse(str));

      const existingComments = await fetchExistingComments(
        octokit,
        owner,
        repo,
        prNumber
      ); // Fetch existing comments on the pull request

      await handleRemovedFiles(
        octokit,
        owner,
        repo,
        existingComments,
        removedFiles
      ); // Delete comments for files that have been removed

      await postNewComments(
        octokit,
        owner,
        repo,
        prNumber,
        existingComments,
        uniqueComments
      ); // Post new comments for added and modified files
    }
  } catch (error) {
    console.error("Error processing pull request:", error);
  }
}

async function getBaseCommitSha(octokit, owner, repo, headSha) {
  const { data: commits } = await octokit.request(
    `GET /repos/${owner}/${repo}/commits`,
    {
      sha: headSha,
      per_page: 2,
    }
  );

  // If there are more than one commit, return the SHA of the second one (base)
  if (commits.length > 1) {
    return commits[1].sha;
  }

  // If there's only one commit, return the head SHA
  return headSha;
}

function parseDiff(diff) {
  const files = diff.files;
  return files.map((file) => {
    const { filename, status, previous_filename } = file;

    return { fileName: filename, status, oldFileName: previous_filename };
  });
}

function filterIgnoredFiles(parsedDiff) {
  const ignoredFiles = ["package.json", "package-lock.json"];
  return parsedDiff.filter((file) => !ignoredFiles.includes(file.fileName));
}

async function fetchFileContents(octokit, owner, repo, parsedDiff, commitId) {
  return await Promise.all(
    parsedDiff.map(async (file) => {
      try {
        const fileContent = await getFileContent(
          octokit,
          owner,
          repo,
          file.fileName,
          commitId
        );
        return { ...file, fileContent };
      } catch (error) {
        if (error.status === 404) {
          return { ...file, fileContent: null };
        } else {
          throw error;
        }
      }
    })
  ).then((results) => results.filter((file) => file !== null)); // Filter out null values
}

async function getFileContent(octokit, owner, repo, path, commitId) {
  const result = await octokit.request(
    `GET /repos/${owner}/${repo}/contents/${path}`,
    {
      ref: commitId, // Specify the commit SHA as the reference
    }
  );

  const content = Buffer.from(result.data.content, "base64").toString("utf-8");
  return content;
}

async function generateReviewComments(fileChanges, commitId) {
  const comments = [];
  const removedFiles = [];
  const prefix = "This comment was generated by AI Bot:\n\n";

  for (const { fileName, status, fileContent, oldFileName } of fileChanges) {
    let explanation = "";
    if (status === "added" || status === "modified") {
      explanation = await getChatCompletion(fileContent);
      comments.push({
        path: fileName,
        body: prefix + explanation,
        commit_id: commitId,
      });
    } else if (status === "removed") {
      removedFiles.push(fileName);
    } else if (status === "renamed") {
      explanation = await getChatCompletion(fileContent);
      comments.push({
        path: fileName,
        body: prefix + explanation,
        commit_id: commitId,
      });

      removedFiles.push(oldFileName);
    }
  }

  return { comments, removedFiles };
}

async function getChatCompletion(fileContent) {
  const messages = [
    {
      role: "system",
      content:
        "You are a Javascript expert. Give explanation in 4 or less short sentences.",
    },
    {
      role: "user",
      content: `Here's a file with JavaScript code:\n\n${fileContent}\n\n${"Please provide an overview of this file."}`,
    },
  ];

  try {
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-3.5-turbo",
        messages,
        temperature: 0.4,
        max_tokens: 3896,
      },
      {
        headers: {
          Authorization: `Bearer ${openaiApiKey}`,
          "Content-Type": "application/json",
        },
      }
    );

    return response.data.choices[0].message.content.trim();
  } catch (error) {
    console.error("Error getting chat completion:", error);
    throw error;
  }
}

async function fetchExistingComments(octokit, owner, repo, pullNumber) {
  const existingComments = await octokit.request(
    `GET /repos/${owner}/${repo}/pulls/${pullNumber}/comments`
  );

  return existingComments.data;
}

async function handleRemovedFiles(
  octokit,
  owner,
  repo,
  existingComments,
  removedFiles
) {
  for (const fileName of removedFiles) {
    const existingComment = existingComments.find(
      (c) =>
        c.path === fileName &&
        c.body.startsWith("This comment was generated by AI Bot:")
    );

    if (existingComment) {
      await octokit.request(
        "DELETE /repos/{owner}/{repo}/pulls/comments/{comment_id}",
        {
          owner,
          repo,
          comment_id: existingComment.id,
        }
      );
    }
  }
}

async function postNewComments(
  octokit,
  owner,
  repo,
  pullNumber,
  existingComments,
  comments
) {
  for (const comment of comments) {
    // Check if there is an existing comment for this path
    const existingComment = existingComments.find(
      (c) =>
        c.path === comment.path &&
        c.body.startsWith("This comment was generated by AI Bot:")
    );

    if (existingComment) {
      // Delete the existing comment
      try {
        await octokit.request(
          "DELETE /repos/{owner}/{repo}/pulls/comments/{comment_id}",
          {
            owner,
            repo,
            comment_id: existingComment.id,
          }
        );
      } catch (error) {
        console.error("Error deleting comment:", error);
      }
    }

    // Post the new comment
    try {
      await octokit.request(
        `POST /repos/{owner}/{repo}/pulls/{pull_number}/comments`,
        {
          owner,
          repo,
          pull_number: pullNumber,
          body: comment.body,
          path: comment.path,
          commit_id: comment.commit_id,
          subject_type: "file",
        }
      );
    } catch (error) {
      console.error("Error posting comment:", error);
    }
  }
}

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
