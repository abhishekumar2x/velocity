import { intro, outro, text, select, confirm, isCancel } from '@clack/prompts';
import { exit } from 'node:process';

async function main() {
  intro(' my-cli-app ');

  const name = await text({
    message: 'What is your name?',
    placeholder: 'Anonymous',
  });

  if (isCancel(name)) {
    console.log('Operation cancelled.');
    exit(0);
  }

  const framework = await select({
    message: 'Choose a framework:',
    options: [
      { value: 'react', label: 'React' },
      { value: 'vue', label: 'Vue' },
      { value: 'svelte', label: 'Svelte' },
    ],
  });

  if (isCancel(framework)) {
    console.log('Operation cancelled.');
    exit(0);
  }

  const shouldProceed = await confirm({
    message: `Create a ${framework} project for ${name}?`,
  });

  if (shouldProceed) {
    outro('Project created successfully!');
  } else {
    outro('Setup aborted.');
  }
}

main();
