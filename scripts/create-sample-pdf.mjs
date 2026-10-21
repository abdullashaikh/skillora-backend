import fs from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';

const outputPath = path.join(process.cwd(), 'samples', 'sample-resume.pdf');
fs.mkdirSync(path.dirname(outputPath), { recursive: true });

const doc = new PDFDocument({ margin: 50 });
const writeStream = fs.createWriteStream(outputPath);
doc.pipe(writeStream);

// Header
doc.fontSize(18).text('Alex Taylor', { align: 'center' });
doc.fontSize(12).text('Senior Full-Stack Software Engineer', { align: 'center' });
doc.fontSize(9).text('alex.taylor@example.com | (555) 019-2834 | Seattle, WA | https://linkedin.com/in/alex-taylor-dev', { align: 'center' });
doc.moveDown(1);

// Professional Summary
doc.fontSize(12).text('PROFESSIONAL SUMMARY', { underline: true });
doc.fontSize(10).text(
  'Results-driven software engineer with 5+ years of experience building high-scale web applications, microservices, and cloud architectures. Proven track record of improving application throughput by 40% and mentoring cross-functional agile teams.'
);
doc.moveDown(0.8);

// Technical Skills
doc.fontSize(12).text('TECHNICAL SKILLS', { underline: true });
doc.fontSize(10).text('Languages: JavaScript, TypeScript, Python, SQL, HTML5, CSS3, Bash');
doc.fontSize(10).text('Frameworks & Libraries: React, Next.js, Node.js, Express, Tailwind CSS, Redux');
doc.fontSize(10).text('Databases: PostgreSQL, MySQL, Redis, MongoDB');
doc.fontSize(10).text('Cloud & DevOps: Amazon Web Services (AWS), Docker, Kubernetes, CI/CD, GitHub Actions');
doc.fontSize(10).text('Methodologies: Agile, Scrum, REST APIs, Microservices, Unit Testing, Jest');
doc.moveDown(0.8);

// Work Experience
doc.fontSize(12).text('WORK EXPERIENCE', { underline: true });
doc.fontSize(11).text('Senior Software Engineer — CloudScale Systems (2022 - Present)');
doc.fontSize(10).text('• Architected and delivered resilient Next.js and TypeScript frontend consuming distributed Node.js microservices, supporting over 200,000 monthly active users.');
doc.fontSize(10).text('• Optimized PostgreSQL database queries and introduced Redis caching, reducing p95 API latency by 45%.');
doc.fontSize(10).text('• Built automated CI/CD deployment pipelines using GitHub Actions and Docker, reducing deployment cycle times from 2 hours to 8 minutes.');
doc.fontSize(10).text('• Mentored 4 junior engineers on clean code practices and test-driven development (TDD).');
doc.moveDown(0.5);

doc.fontSize(11).text('Software Engineer — Apex Digital Solutions (2020 - 2022)');
doc.fontSize(10).text('• Developed responsive web interfaces using React, Redux, and Tailwind CSS for enterprise analytics clients.');
doc.fontSize(10).text('• Engineered secure RESTful APIs using Python and FastAPI, handling 5,000 requests per minute with 99.9% uptime.');
doc.fontSize(10).text('• Collaborated with product designers in bi-weekly Agile sprints to deliver 15+ major client features ahead of schedule.');
doc.moveDown(0.8);

// Technical Projects
doc.fontSize(12).text('TECHNICAL PROJECTS', { underline: true });
doc.fontSize(11).text('E-Commerce Real-time Analytics Platform (Next.js, TypeScript, PostgreSQL, Docker)');
doc.fontSize(10).text('• Created open-source real-time metrics dashboard visualizing transactional events via WebSocket streams.');
doc.fontSize(10).text('• Achieved sub-second data synchronization and deployed on AWS ECS with auto-scaling.');
doc.moveDown(0.5);

doc.fontSize(11).text('TaskFlow Orchestration CLI (Python, Redis, Docker)');
doc.fontSize(10).text('• Built lightweight distributed task queuing worker in Python with Redis backend.');
doc.moveDown(0.8);

// Education & Certifications
doc.fontSize(12).text('EDUCATION & CERTIFICATIONS', { underline: true });
doc.fontSize(10).text('Bachelor of Science in Computer Science | University of Washington | 2016 - 2020');
doc.fontSize(10).text('AWS Certified Solutions Architect – Associate | Amazon Web Services | 2023');

doc.end();

writeStream.on('finish', () => {
  console.log(`Valid sample PDF generated successfully at: ${outputPath}`);
});
