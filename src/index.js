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
  try {
    const action = req.body.action;
    const pr = req.body.pull_request;

    // React to 'opened' and 'synchronize' actions
    if (pr && (action === "opened" || action === "synchronize")) {
      const owner = pr.base.repo.owner.login;
      const repo = pr.base.repo.name;
      const prNumber = pr.number;

      const headCommitSha = pr.head.sha; // Get the latest commit SHA
      const baseCommitSha = await getBaseCommitSha(owner, repo, headCommitSha);

      const diffData = await octokit.repos.compareCommits({
        owner,
        repo,
        base: baseCommitSha,
        head: headCommitSha,
      });

      const parsedDiff = parseDiff(diffData.data);
      const filteredDiff = filterIgnoredFiles(parsedDiff); // Filter out ignored files
      const fileChanges = await fetchFileContents(
        owner,
        repo,
        filteredDiff,
        headCommitSha
      );
      const reviewComments = await generateReviewComments(
        fileChanges,
        headCommitSha
      );

      await updateReviewComments(owner, repo, prNumber, reviewComments);

      res.status(200).send("Webhook received and processed");
    } else {
      res.status(400).send("Not a pull request event");
    }
  } catch (error) {
    console.error("Error processing webhook:", error);
    res.status(500).send("Internal server error");
  }
});

async function getBaseCommitSha(owner, repo, headSha) {
  const commits = await octokit.repos.listCommits({
    owner,
    repo,
    sha: headSha,
    per_page: 2,
  });

  // If there are more than one commit, return the SHA of the second one (base)
  if (commits.data.length > 1) {
    return commits.data[1].sha;
  }

  // If there's only one commit, return the head SHA
  return headSha;
}

function parseDiff(diff) {
  const files = diff.files;
  return files.map((file) => {
    const { filename, status, patch } = file;

    const changes = patch
      ? patch
          .split("\n")
          .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
          .map((line) => ({
            line: line.slice(1).trim(),
          }))
      : [];

    return { fileName: filename, status, changes };
  });
}

function filterIgnoredFiles(parsedDiff) {
  const ignoredFiles = ["package.json", "package-lock.json"];
  return parsedDiff.filter((file) => !ignoredFiles.includes(file.fileName));
}

async function fetchFileContents(owner, repo, parsedDiff, commitId) {
  return await Promise.all(
    parsedDiff.map(async (file) => {
      try {
        const fileContent = await getFileContent(
          owner,
          repo,
          file.fileName,
          commitId
        );
        return { ...file, fileContent };
      } catch (error) {
        if (error.status === "404") {
          return null;
        } else {
          throw error;
        }
      }
    })
  ).then((results) => results.filter((file) => file !== null)); // Filter out null values
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

  for (const { fileName, status, fileContent, changes } of fileChanges) {
    // const explanation =
    //   status === "added"
    //     ? await getChatCompletion(fileContent)
    //     : await getChatCompletion(fileContent, changes);
    comments.push({
      path: fileName,
      body: prefix + status,
      commit_id: commitId,
    });
  }

  return comments;
}

async function getChatCompletion(fileContent, changes = null) {
  const messages = [
    {
      role: "system",
      content:
        "You are a Javascript expert. Give explanation in 4 or less short sentences.",
    },
    {
      role: "user",
      content: `Here's a file with JavaScript code:\n\n${fileContent}\n\n${
        changes
          ? `The following lines have been changed:\n\n
          ${changes
            .map((change) => change.line)
            .join("\n")}\n\nPlease explain these changes:`
          : "Please provide an overview of this file."
      }`,
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
