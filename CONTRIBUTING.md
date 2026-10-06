# Contributing to CSF Profile Assessment Database

Thanks for contributing to the CSF Profile Assessment Database! Here's what you need to know to get started quickly.

## Two Ways to Contribute

| Track | Who it's for | Skills needed |
|-------|-------------|---------------|
| [📝 Contribute Without Code](#-contribute-without-code) | GRC practitioners, auditors, career-changers, students | GRC knowledge + Markdown. **No programming.** |
| [💻 Contribute Code](#-contribute-code) | Developers | React / Node.js |

Both tracks end the same way: a merged PR with your name in [CONTRIBUTORS.md](CONTRIBUTORS.md), on a project listed in the NIST.gov community resources.

## 📝 Contribute Without Code

This project needs assessment content as much as it needs code: test procedures, assessment artifacts, observations, and findings for the fictional "Alma Security" case study in [ASSESSMENT_CATALOG/](ASSESSMENT_CATALOG/). Writing these is real GRC work — the same skill you'd use on an engagement — and it makes a strong portfolio piece.

**Your first contribution, step by step:**

1. **Pick a subcategory.** Browse the open [`good first issue`](https://github.com/CPAtoCybersecurity/csf_profile/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) issues — each covers one CSF category (e.g., GV.SC, RS.CO) and lists its subcategories. Pick ONE subcategory (e.g., RS.CO-02) and **comment on the issue to claim it** so nobody doubles up.
2. **Read the case study.** [ASSESSMENT_CATALOG/1_Case_Study/](ASSESSMENT_CATALOG/1_Case_Study/) has Alma Security's backgrounder, business case, and financials — enough context to write realistic material.
3. **Draft your contribution.** For your subcategory, write: a few test-procedure steps, explicit pass/fail criteria, and (optionally) example artifacts or interview questions with expected answers. Use an already-merged contribution as your template — [PR #202](https://github.com/CPAtoCybersecurity/csf_profile/pull/202) is a good model, and the existing files in [ASSESSMENT_CATALOG/3_Test_Procedures/](ASSESSMENT_CATALOG/3_Test_Procedures/) show the file structure and naming pattern.
4. **Open a PR** referencing the issue. Format your files as Markdown, follow the folder's naming convention, and keep the PR scoped to your subcategory. A maintainer will review and give feedback — first drafts are never expected to be perfect.

**Full walkthrough for first-timers** (GitHub account setup through merged PR): [Your First Contribution to the CSF Profile Assessment Database](https://www.cpatocybersecurity.com/p/your-first-contribution-to-the-simply-cyber-csf-profile-assessment-database)

Other welcome no-code contributions: fixing documentation gaps, improving onramp guides ([GET_THE_SPREADSHEETS/](GET_THE_SPREADSHEETS/), [GET_THE_NOTION_TEMPLATE/](GET_THE_NOTION_TEMPLATE/)), and writing example audit reports against the case study.

## 💻 Contribute Code

## Quick Setup

### Prerequisites

- Node.js 18+ installed (LTS version recommended)
- Git configured with your details
- GitHub CLI (`gh`) recommended

### Getting Started

```bash
# Clone your fork (upstream is set automatically)
gh repo clone YOUR_GITHUB_USER/csf_profile
cd csf_profile

# Install dependencies
npm install

# Start the development server
npm start

# Run tests
npm test
```

The application will be available at [http://localhost:3000](http://localhost:3000).

## Development Guidelines

### Code Style

- Follow standard React/JavaScript conventions
- Use meaningful variable and function names
- Write tests for new functionality
- Keep components focused and small
- Use functional components with hooks

### Commit Messages

Use descriptive commit messages:

```
feat: add new dashboard visualization
fix: resolve CSV export encoding issue
docs: update installation instructions
refactor: simplify control scoring logic
test: add unit tests for import functionality
```

### Project Structure

```
src/
├── components/    # Reusable UI components
├── hooks/         # Custom React hooks
├── pages/         # Page-level components
├── storage/       # Persistence layer: localStorage vs. server sync (see "Persisted stores")
├── stores/        # Zustand state management
├── utils/         # Utility functions
└── App.js         # Main application entry
public/            # Static assets and templates
server/            # Express server: AI proxy, plus accounts/SQLite in multi-user mode
docs/              # SELF_HOSTING.md, MULTI_USER.md, design specs
```

## Pull Request Process

### Pull Request Guidelines

Keep pull requests focused and minimal.

PRs that touch a large number of files (50+) without clear functional justification will likely be rejected without detailed review.

### Why We Enforce This

- **Reviewability**: Large PRs are effectively un-reviewable. Reviewer effectiveness drops significantly after ~200-400 lines of code.
- **Git history**: Sweeping changes pollute git blame, making it harder to trace when and why functional changes were made.
- **Merge conflicts**: Large PRs increase the likelihood of conflicts with other contributors' work.
- **Risk**: More changed lines means more opportunities for subtle bugs, even in "safe" refactors.

### What to Do Instead

If you have a large change in mind, break it into logical, independently-mergeable slices. For example:

- "Update all button components to use new design system" (single UI change, easy to verify)
- "Refactor scoring logic in Dashboard component" (scoped to one feature)
- "Modernize entire codebase with multiple updates" (too broad, impossible to review)

For sweeping refactors or style changes, open an issue first to discuss the approach with maintainers before investing time in the work.

### PR Steps

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/your-feature-name`)
3. Make your changes
4. Write/update tests
5. Run `npm test` to ensure all tests pass
6. Run `npm run build` to verify the build succeeds
7. Submit PR with clear description

### Review Process

- PRs require maintainer review
- Address feedback promptly
- Keep PRs focused on single features/fixes

## Testing

### Run Tests

```bash
# Run all tests
npm test

# Run tests with coverage
npm test -- --coverage

# Run tests in CI mode (non-interactive)
npm test -- --watchAll=false
```

### Server tests

The server (`server/`) has its own tests, which use Node's built-in test runner (Node 18+):

```bash
cd server
npm ci
npm test
```

### Running in server (multi-user) mode locally

```bash
# Terminal 1: build the client in server mode, then run the server (serves the build on port 4000)
REACT_APP_SERVER_MODE=true INLINE_RUNTIME_CHUNK=false npm run build
cd server && npm ci && MULTIUSER=true STATIC_DIR=../build DATA_DIR=/tmp/csf-dev node index.js
# open http://localhost:4000 and create the admin account
```

Use a throwaway `DATA_DIR` while developing. The details, env vars and Docker are in [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md).
Most client tests run in local mode; tests that cover mode-specific behaviour set `process.env.REACT_APP_SERVER_MODE`
themselves and restore it afterwards. `better-sqlite3` is pinned to `^11` in `server/package.json` because it must run
on Node 18 (newer majors drop Node 18 support); do not bump it without also moving the supported Node version.

### Test Requirements

- Unit tests for utility functions
- Component tests for UI logic
- Integration tests for data import/export functionality

## Component Guidelines

### Creating Components

Components go in `src/components/` or `src/pages/`:

```jsx
import React from 'react';

const MyComponent = ({ prop1, prop2 }) => {
  // Component logic here

  return (
    <div className="my-component">
      {/* JSX content */}
    </div>
  );
};

export default MyComponent;
```

### Component Best Practices

- Use functional components with hooks
- Keep components small and focused
- Extract reusable logic into custom hooks
- Use prop-types or TypeScript for type safety
- Follow existing naming conventions in the codebase

## State Management

This project uses [Zustand](https://github.com/pmndrs/zustand) for state management. Stores are located in `src/stores/`.

When adding new state:

1. Consider if the state belongs in an existing store
2. Keep stores focused on specific domains
3. Use selectors for derived state
4. Document any complex state interactions

### Persisted stores (multi-user mode)

Every persisted zustand store (anything created with `persist(...)` and a `name`) must be given an explicit decision in
`src/storage/storeConfigs.js`: either which collections sync to the server (and their unique key per item), plus any
`localFields` that stay per-browser, or `local: true` for a store that is per-browser in every mode. Create the store's
storage with `createStorage('<store name>')` from `src/storage/createStorage.js`. Synced stores must also be registered
in `src/storage/registerStores.js` so they refresh when other people's changes arrive.

Add the store's name to `ALL_PERSIST_NAMES` in `src/storage/storeConfigs.test.js` (and to the `loaders` map if it
syncs), so the suite proves it has a decision and that its default data has unique keys. Likewise update
`registerStores.test.js`. A synced collection item needs a stable unique id; items without one cannot be synced.

User-facing wording that depends on where data lives ("saved in your browser" versus "saved to the server") must be
gated on `isServerMode()` and tested in both modes (see `src/utils/modeCopy.js`).

## Documentation

- Update README.md for new features
- Include usage examples for new functionality
- Update SCREENSHOTS.md if UI changes significantly
- If you change anything about where data is stored or who can see it, update PRIVATE_DATA.md, SECURITY.md and docs/SELF_HOSTING.md too
- Keep documentation current with code changes

## Security Considerations

This tool handles cybersecurity assessment data. When contributing:

- Never log or expose sensitive assessment data
- Sanitize user inputs (the project uses DOMPurify)
- Be mindful of XSS vulnerabilities in rendered content
- Test CSV import/export for injection vulnerabilities

## Getting Help

- Check existing [issues](https://github.com/CPAtoCybersecurity/csf_profile/issues) first
- Ask questions in discussions
- Be patient - maintainers are volunteers
- Join the [Simply Cyber Discord](https://simplycyber.io/discord) community for broader discussions

## Feature Requests

If you have ideas for improving CSF assessments or the tool:

1. Check if the feature has already been requested
2. Open an issue describing the feature and its benefits
3. Include examples of how it would be used
4. Reference relevant NIST CSF documentation if applicable

## License

By contributing, you agree your contributions will be licensed under the [MIT License](LICENSE).
